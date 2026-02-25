"""Evolution loop orchestrator — state machine driving the closed-loop cycle."""
from __future__ import annotations

import datetime
import logging
import time
import uuid
from dataclasses import asdict
from pathlib import Path

from .analyzer import FeedbackSignal, analyze_evaluation, build_evolution_record
from .bridge import BridgeError, QFTLBridge
from .config import LoopConfig, load_loop_config
from .formatter import format_for_qftl, install_dataset_config, merge_domain_datasets
from .state import EvolutionRecord, Stage, StateStore, StopReason

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / "data"
LOOP_DATA_DIR = DATA_DIR / "loop"


class EvolutionError(Exception):
    """Non-retryable error during an evolution stage."""


class Orchestrator:
    """Drives the generate → train → evaluate → analyze loop."""

    def __init__(
        self,
        config: LoopConfig | None = None,
        config_path: str | Path | None = None,
        state_store: StateStore | None = None,
        emit_fn: callable | None = None,
        initial_dataset_path: str | None = None,
        dataset_name: str = "",
        dataset_id: int | None = None,
    ):
        self.cfg = config or load_loop_config(config_path)
        self.store = state_store or StateStore()
        self.bridge = QFTLBridge(self.cfg.qftl)
        self._loop_id: str | None = None
        self._emit_fn = emit_fn
        self._wandb_run = None
        self._initial_dataset_path = initial_dataset_path
        self._dataset_name = dataset_name
        self._dataset_id = dataset_id

    # ------------------------------------------------------------------
    # SSE event helper
    # ------------------------------------------------------------------

    def _emit(self, event: dict):
        """Push a structured event to the SSE stream (if emit_fn is set)."""
        if self._emit_fn and self._loop_id:
            try:
                self._emit_fn(self._loop_id, event)
            except Exception:
                pass  # never let SSE problems break the loop

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self, loop_id: str | None = None) -> str:
        """Run the full evolution loop until a termination condition is met.

        Returns the loop_id.
        """
        if not self.bridge.health_check():
            raise EvolutionError("QFTL server is not reachable at %s" % self.cfg.qftl.base_url)

        self._loop_id = loop_id or f"loop-{uuid.uuid4().hex[:12]}"
        state = self.store.create_loop(self._loop_id, self._config_snapshot())
        log.info("Starting evolution loop %s (max %d evolutions, target %.1f%%)",
                 self._loop_id, self.cfg.evolution.max_evolutions, self.cfg.evolution.target_accuracy)

        self._emit({"type": "status", "data": "running"})
        self._emit({"type": "config", "data": self._config_snapshot()})
        self._init_wandb()

        feedback: FeedbackSignal | None = None

        for evo in range(1, self.cfg.evolution.max_evolutions + 1):
            if self._should_stop():
                self.store.finish_loop(self._loop_id, StopReason.MANUAL_STOP)
                log.info("Loop %s: manual stop requested after evo %d", self._loop_id, evo - 1)
                self._emit({"type": "done", "stop_reason": "MANUAL_STOP"})
                self._finish_wandb("MANUAL_STOP")
                return self._loop_id

            try:
                feedback = self._run_evolution(evo, feedback)
            except EvolutionError as e:
                log.error("Loop %s: evo %d failed irrecoverably: %s", self._loop_id, evo, e)
                self.store.finish_loop(self._loop_id, StopReason.ABORTED)
                self._emit({"type": "error", "data": str(e)})
                self._emit({"type": "done", "stop_reason": "ABORTED"})
                self._finish_wandb("ABORTED")
                return self._loop_id

            if feedback.stop:
                reason = StopReason(feedback.stop_reason)
                self.store.finish_loop(self._loop_id, reason)
                log.info("Loop %s: terminated after evo %d — %s (score=%.1f)",
                         self._loop_id, evo, reason.value, feedback.overall_score)
                self._emit({"type": "done", "stop_reason": reason.value})
                self._finish_wandb(reason.value)
                return self._loop_id

        self.store.finish_loop(self._loop_id, StopReason.MAX_EVOLUTIONS)
        log.info("Loop %s: reached max evolutions", self._loop_id)
        self._emit({"type": "done", "stop_reason": "MAX_EVOLUTIONS"})
        self._finish_wandb("MAX_EVOLUTIONS")
        return self._loop_id

    def resume(self, loop_id: str) -> str:
        """Resume a previously interrupted loop."""
        state = self.store.get_loop(loop_id)
        if not state:
            raise ValueError(f"No loop found with id {loop_id}")
        if state.status != "running":
            raise ValueError(f"Loop {loop_id} is not resumable (status={state.status})")

        self._loop_id = loop_id
        last_evo = state.current_evolution
        feedback: FeedbackSignal | None = None

        if state.evolutions:
            last_record = state.evolutions[-1]
            feedback = self._record_to_feedback(last_record)

        start_evo = last_evo + 1 if state.current_stage == Stage.ANALYZING.value else max(last_evo, 1)
        log.info("Resuming loop %s from evo %d", loop_id, start_evo)

        for evo in range(start_evo, self.cfg.evolution.max_evolutions + 1):
            if self._should_stop():
                self.store.finish_loop(self._loop_id, StopReason.MANUAL_STOP)
                return self._loop_id

            try:
                feedback = self._run_evolution(evo, feedback)
            except EvolutionError as e:
                log.error("Loop %s: evo %d failed: %s", self._loop_id, evo, e)
                self.store.finish_loop(self._loop_id, StopReason.ABORTED)
                return self._loop_id

            if feedback.stop:
                self.store.finish_loop(self._loop_id, StopReason(feedback.stop_reason))
                return self._loop_id

        self.store.finish_loop(self._loop_id, StopReason.MAX_EVOLUTIONS)
        return self._loop_id

    # ------------------------------------------------------------------
    # Single evolution cycle
    # ------------------------------------------------------------------

    def _run_evolution(self, evo: int, prev_feedback: FeedbackSignal | None) -> FeedbackSignal:
        """Execute one full evolution: generate -> format -> transfer -> train -> convert -> evaluate -> analyze."""
        evo_t0 = time.monotonic()
        started_at = datetime.datetime.utcnow().isoformat()
        state = self.store.get_loop(self._loop_id)
        previous_records = state.evolutions if state else []
        retry_limit = self.cfg.evolution.stage_retry_limit
        stage_timings: dict[str, float] = {}

        def _stage(stage: Stage):
            self.store.update_stage(self._loop_id, evo, stage)
            self._emit({"type": "stage", "stage": stage.value, "evolution": evo})
            self._emit({"type": "log", "data": f"[evo {evo}] Starting stage: {stage.value}"})

        def _timed(stage: Stage, fn, *args, **kwargs):
            _stage(stage)
            t0 = time.monotonic()
            result = fn(*args, **kwargs)
            elapsed = time.monotonic() - t0
            stage_timings[stage.value] = elapsed
            log.info("[perf] evo %d  %s  %.1fs", evo, stage.value, elapsed)
            self._emit({"type": "log", "data": f"[evo {evo}] {stage.value} finished in {elapsed:.1f}s"})
            return result

        # --- 1. GENERATE (or use selected dataset for evo 1) ---
        if evo == 1 and self._initial_dataset_path:
            dataset_path = Path(self._initial_dataset_path)
            _stage(Stage.GENERATING)
            log.info("Using selected dataset: %s (%s)", self._dataset_name, dataset_path)
            self._emit({"type": "log", "data": f"[evo {evo}] Using selected dataset: {self._dataset_name}"})
        else:
            dataset_path = _timed(Stage.GENERATING, self._stage_generate, evo, prev_feedback, retries=retry_limit)

        # --- 2. FORMAT ---
        formatted_path, config_yaml, config_name = _timed(Stage.FORMATTING, self._stage_format, evo, dataset_path)

        # --- 3. TRANSFER ---
        _timed(Stage.TRANSFERRING, self._stage_transfer, formatted_path, config_yaml, config_name, retries=retry_limit)

        # --- 4. TRAIN ---
        train_result = _timed(Stage.TRAINING, self._stage_train, config_name, str(formatted_path), retries=retry_limit)

        # --- 5. CONVERT ---
        convert_result = _timed(Stage.CONVERTING, self._stage_convert, train_result, retries=retry_limit)

        # --- 6. EVALUATE ---
        eval_result = _timed(
            Stage.EVALUATING, self._stage_evaluate,
            convert_result, str(formatted_path), train_result, retries=retry_limit,
        )

        # --- 7. ANALYZE ---
        feedback = _timed(
            Stage.ANALYZING, analyze_evaluation,
            detailed_results=eval_result.detailed_results,
            previous_records=previous_records,
            evolution=evo,
            evo_config=self.cfg.evolution,
            feedback_config=self.cfg.feedback,
        )

        completed_at = datetime.datetime.utcnow().isoformat()
        record = build_evolution_record(
            signal=feedback,
            dataset_path=str(dataset_path),
            adapter_path=train_result.adapter_path,
            gguf_path=convert_result.output_path,
            qftl_training_id=train_result.id,
            qftl_eval_id=eval_result.id,
            qftl_convert_id=None,
            started_at=started_at,
            completed_at=completed_at,
        )
        self.store.save_evolution(self._loop_id, record)

        # Emit metrics for the convergence chart
        self._emit({
            "type": "metrics",
            "evolution": evo,
            "overall_score": record.overall_score,
            "factual_accuracy": record.factual_accuracy,
            "completeness": record.completeness,
            "technical_precision": record.technical_precision,
            "best_score_so_far": record.best_score_so_far,
            "delta_from_previous": record.delta_from_previous,
            "target_reached": record.target_reached,
            "domain_scores": record.domain_scores,
        })
        self._log_wandb_evolution(evo, record, stage_timings)

        evo_elapsed = time.monotonic() - evo_t0
        timing_summary = "  ".join(f"{k}={v:.1f}s" for k, v in stage_timings.items())
        log.info(
            "[perf] evo %d total %.1fs  breakdown: %s",
            evo, evo_elapsed, timing_summary,
        )
        log.info(
            "Evo %d complete: score=%.1f  best=%.1f  delta=%.1f  stop=%s",
            evo, feedback.overall_score, feedback.best_score_so_far,
            feedback.delta_from_previous, feedback.stop,
        )
        self._emit({"type": "log", "data": f"[evo {evo}] Complete in {evo_elapsed:.1f}s: score={feedback.overall_score:.1f} best={feedback.best_score_so_far:.1f} delta={feedback.delta_from_previous:+.1f}"})
        return feedback

    # ------------------------------------------------------------------
    # Stage implementations
    # ------------------------------------------------------------------

    def _stage_generate(self, evo: int, feedback: FeedbackSignal | None, retries: int = 2) -> Path:
        """Generate synthetic dataset using SDGS scrape pipeline."""
        from ..scrape import run_scrape

        domains = self.cfg.generation.domains
        base_samples = self.cfg.generation.initial_samples_per_domain

        # Targeted generation for evo 2+: only generate for weak domains
        if feedback is not None:
            base_samples = 0

        domain_budgets: dict[str, int] = {}
        for domain in domains:
            budget = base_samples
            if feedback:
                for df in feedback.domains:
                    if df.domain.lower() == domain.lower() and df.sample_budget > 0:
                        budget += df.sample_budget
                        break
            domain_budgets[domain] = budget

        # Skip domains with 0 budget (strong domains in targeted mode)
        domain_budgets = {d: b for d, b in domain_budgets.items() if b > 0}
        if not domain_budgets and feedback is not None:
            raise EvolutionError("All domains scored well -- no weak domains to generate data for")

        domain_paths: dict[str, Path] = {}
        for domain, budget in domain_budgets.items():
            output_path = LOOP_DATA_DIR / f"evo{evo:03d}_{domain}.jsonl"
            output_path.parent.mkdir(parents=True, exist_ok=True)

            for attempt in range(retries + 1):
                try:
                    run_scrape(
                        topic=domain,
                        provider=self.cfg.generation.provider,
                        model=None,
                        api_key=None,
                        task_name=self.cfg.generation.task_config,
                        max_papers=max(budget // 25, 5),
                        top_n=max(min(budget // 50, 10), 1),
                        output_path=str(output_path),
                        collect_only=False,
                    )
                    domain_paths[domain] = output_path
                    break
                except Exception as e:
                    log.warning("Generate %s attempt %d failed: %s", domain, attempt + 1, e)
                    if attempt >= retries:
                        log.error("Generate %s exhausted retries", domain)

        if not domain_paths:
            raise EvolutionError("All domain generation attempts failed")

        merged_path = LOOP_DATA_DIR / f"evo{evo:03d}_merged.jsonl"
        merged_path, _, _ = merge_domain_datasets(domain_paths, merged_path, evo)
        return merged_path

    def _stage_format(self, evo: int, raw_path: Path) -> tuple[Path, str, str]:
        """Format SDGS output to QFTL-compatible JSONL."""
        formatted_path = LOOP_DATA_DIR / f"evo{evo:03d}_formatted.jsonl"
        return format_for_qftl(raw_path, formatted_path, "Multi-Domain", evo)

    def _stage_transfer(self, jsonl_path: Path, config_yaml: str, config_name: str, retries: int = 2):
        """Install formatted dataset config into the engine configs directory."""
        try:
            install_dataset_config(config_yaml, config_name)
            log.info("Installed dataset config: %s", config_name)
        except Exception as e:
            raise EvolutionError(f"Dataset config install failed: {e}")

    def _stage_train(self, dataset_config_name: str, dataset_path: str, retries: int = 2):
        """Start and monitor training on QFTL."""
        for attempt in range(retries + 1):
            try:
                status = self.bridge.start_training(
                    model_config_name=self.cfg.training.model_config,
                    dataset_config_name=dataset_config_name,
                    training_config_name=self.cfg.training.training_config,
                    dataset_path=dataset_path,
                )
                result = self.bridge.poll_training(
                    status.id,
                    check_stop=lambda: self._should_stop(),
                )
                if result.status == "completed":
                    return result
                if result.status == "cancelled" or self._should_stop():
                    raise EvolutionError("Training cancelled or stop requested")
                raise BridgeError(f"Training failed: {result.error_message}")
            except BridgeError as e:
                log.warning("Train attempt %d failed: %s", attempt + 1, e)
                if attempt >= retries:
                    raise EvolutionError(f"Training failed after {retries + 1} attempts: {e}")

    def _stage_convert(self, train_result, retries: int = 2):
        """Convert LoRA adapter to GGUF on QFTL (synchronous)."""
        if not train_result.adapter_path:
            raise EvolutionError("No adapter path from training -- cannot convert")

        output_name = train_result.run_name or f"evo-adapter-{train_result.id}"

        for attempt in range(retries + 1):
            try:
                result = self.bridge.start_conversion(
                    adapter_path=train_result.adapter_path,
                    output_name=output_name,
                )
                if result.status == "completed":
                    return result
                raise BridgeError(f"Conversion failed: status={result.status}")
            except BridgeError as e:
                log.warning("Convert attempt %d failed: %s", attempt + 1, e)
                if attempt >= retries:
                    raise EvolutionError(f"Conversion failed after {retries + 1} attempts: {e}")

    def _stage_evaluate(self, convert_result, test_dataset_path: str, train_result=None, retries: int = 2):
        """Evaluate the converted model on QFTL."""
        if not convert_result.output_path:
            raise EvolutionError("No GGUF path from conversion -- cannot evaluate")

        training_run_id = train_result.id if train_result else None

        for attempt in range(retries + 1):
            try:
                status = self.bridge.start_evaluation(
                    model_path=convert_result.output_path,
                    test_dataset_path=test_dataset_path,
                    max_samples=self.cfg.evaluation.sample_count,
                    judge_model=self.cfg.evaluation.judge_model,
                    training_run_id=training_run_id,
                )
                eval_status = self.bridge.poll_evaluation(
                    status.id,
                    check_stop=lambda: self._should_stop(),
                )
                if eval_status.status == "completed":
                    return self.bridge.get_evaluation_detail(status.id)
                raise BridgeError(f"Evaluation failed: {eval_status.error_message}")
            except BridgeError as e:
                log.warning("Evaluate attempt %d failed: %s", attempt + 1, e)
                if attempt >= retries:
                    raise EvolutionError(f"Evaluation failed after {retries + 1} attempts: {e}")

    # ------------------------------------------------------------------
    # Wandb tracking
    # ------------------------------------------------------------------

    def _init_wandb(self):
        """Initialize a wandb run for the evolution loop."""
        if not self.cfg.wandb.enabled:
            self._wandb_run = None
            return
        try:
            import wandb
        except ImportError:
            log.warning("wandb not installed -- disabling wandb tracking")
            self._wandb_run = None
            return
        self._wandb_run = wandb.init(
            project=self.cfg.wandb.project,
            entity=self.cfg.wandb.entity or None,
            name=self._loop_id,
            config=self._config_snapshot(),
            tags=self.cfg.wandb.tags,
            resume="allow",
        )

    def _log_wandb_evolution(self, evo: int, record, stage_timings: dict):
        """Log per-evolution metrics to wandb."""
        if not self._wandb_run:
            return
        import wandb
        wandb.log({
            "evolution": evo,
            "overall_score": record.overall_score,
            "factual_accuracy": record.factual_accuracy,
            "completeness": record.completeness,
            "technical_precision": record.technical_precision,
            "best_score_so_far": record.best_score_so_far,
            "delta_from_previous": record.delta_from_previous,
        }, step=evo)
        wandb.log({
            f"timing/{k}": v for k, v in stage_timings.items()
        }, step=evo)
        if record.domain_scores:
            wandb.log({
                f"domain/{domain}/overall_score": score
                for domain, score in record.domain_scores.items()
            }, step=evo)

    def _finish_wandb(self, stop_reason: str):
        """Finalize the wandb run with summary info."""
        if not self._wandb_run:
            return
        import wandb
        wandb.summary["stop_reason"] = stop_reason
        wandb.finish()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _should_stop(self) -> bool:
        return self.store.is_stop_requested(self._loop_id)

    def _config_snapshot(self) -> dict:
        return {
            "qftl": asdict(self.cfg.qftl),
            "evolution": asdict(self.cfg.evolution),
            "generation": asdict(self.cfg.generation),
            "training": asdict(self.cfg.training),
            "evaluation": asdict(self.cfg.evaluation),
            "feedback": asdict(self.cfg.feedback),
            "wandb": asdict(self.cfg.wandb),
            "selected_dataset": {
                "id": self._dataset_id,
                "name": self._dataset_name,
            },
        }

    @staticmethod
    def _record_to_feedback(record: EvolutionRecord) -> FeedbackSignal:
        """Reconstruct a minimal FeedbackSignal from a saved EvolutionRecord."""
        return FeedbackSignal(
            evolution=record.evolution,
            stop=False,
            stop_reason=None,
            overall_score=record.overall_score,
            best_score_so_far=record.best_score_so_far,
            delta_from_previous=record.delta_from_previous,
            delta_from_best=record.delta_from_best,
            consecutive_regressions=record.consecutive_regressions,
            consecutive_plateaus=record.consecutive_plateaus,
            target_reached=record.target_reached,
            domains=[],
        )
