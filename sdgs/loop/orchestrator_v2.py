"""Closed-loop orchestrator -- wires together all components into an 8-stage cycle.

Stages per cycle:
    BASELINE -> TALLY -> RETRIEVE -> CURATE -> TRAIN -> MERGE -> EVALUATE -> GATE
"""
from __future__ import annotations

import datetime
import logging
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any

from sdgs.loop.benchmark_runner import compute_gate_score, run_benchmarks
from sdgs.loop.config_v2 import ClosedLoopConfig, load_closed_loop_config
from sdgs.loop.curator import generate_pairs, save_dataset
from sdgs.loop.cycle_logger import CycleLogger
from sdgs.loop.email_reporter import build_report_body, send_fail_cap_email
from sdgs.loop.quality_gate import cleanup_checkpoints, evaluate_gate, rollback_merge
from sdgs.loop.retriever import extract_paper_text, retrieve_papers
from sdgs.loop.state_v2 import CycleRecord, LoopStateStore, Stage, StopReason
from sdgs.loop.tally_agent import run_tally
from sdgs.loop.vram import unload_all_models, unload_model

logger = logging.getLogger(__name__)


class ClosedLoopOrchestrator:
    """Main orchestrator that drives the closed-loop training mechanism.

    Runs an 8-stage cycle:
        [0] BASELINE  -- benchmark unmodified base model
        [1] TALLYING  -- diagnose failures with the tally agent
        [2] RETRIEVING -- retrieve papers based on tally analysis
        [3] CURATING  -- generate training pairs from papers
        [4] TRAINING  -- fine-tune with QwenTrainer (LoRA)
        [5] MERGING   -- merge LoRA adapter into base model
        [6] EVALUATING -- benchmark the merged model
        [7] GATING    -- accept or rollback the merge
    """

    def __init__(
        self,
        config: ClosedLoopConfig | None = None,
        config_path: str | Path | None = None,
        state_db: str | Path | None = None,
        seed_dataset_path: str | None = None,
    ):
        if config is not None:
            self._config = config
        else:
            self._config = load_closed_loop_config(config_path)

        self._state = LoopStateStore(db_path=state_db)

        log_dir = Path(self._config.logging.log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        self._logger = CycleLogger(
            log_dir=log_dir,
            cycle_log_name=self._config.logging.cycle_log,
            project_log_name=self._config.logging.project_log,
        )

        self._base_model_path: str = self._config.training.base_model
        checkpoint_dir = Path(self._config.training.checkpoint_dir)
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        self._checkpoint_dir: Path = checkpoint_dir
        self._current_version: int = 0
        self._previous_average: float = 0.0
        self._seed_dataset_path: str | None = seed_dataset_path
        self._consecutive_failures: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self, loop_id: str | None = None) -> str:
        """Execute the full closed-loop cycle.

        Args:
            loop_id: Optional identifier for this loop run.  Generated if
                not provided.

        Returns:
            The loop_id used for the run.
        """
        if loop_id is None:
            loop_id = uuid.uuid4().hex[:8]

        config_snapshot = asdict(self._config)
        self._state.create_loop(loop_id, config_snapshot)

        project_id = loop_id
        suites = self._config.benchmarks.suites
        batch_size = self._config.benchmarks.batch_size

        # ---------------------------------------------------------------
        # [0] BASELINE -- benchmark unmodified base model
        # ---------------------------------------------------------------
        self._state.update_stage(loop_id, 0, Stage.BASELINE)
        unload_all_models()  # free Ollama VRAM before loading HF model
        logger.info("Cycle 0: BASELINE benchmark on %s", self._base_model_path)

        t0 = time.time()
        baseline_result = run_benchmarks(self._base_model_path, suites, batch_size)
        baseline_scores = baseline_result["scores"]
        baseline_avg = compute_gate_score(baseline_scores)
        logger.info("BASELINE completed in %.1fs -- average=%.2f, scores=%s",
                     time.time() - t0, baseline_avg, baseline_scores)
        self._previous_average = baseline_avg

        baseline_record = CycleRecord(
            cycle=0,
            benchmark_scores=baseline_scores,
            gate_passed=None,
            gate_delta=0.0,
            consecutive_gate_failures=0,
            merged_model_path=None,
            tally_metadata={},
            dataset_path=None,
            dataset_size=0,
            adapter_path=None,
            training_loss=None,
            started_at=datetime.datetime.utcnow().isoformat(),
            completed_at=datetime.datetime.utcnow().isoformat(),
        )
        self._state.save_cycle(loop_id, baseline_record)

        self._logger.create_project(
            project_id=project_id,
            domain="closed-loop",
            base_model=self._base_model_path,
            baseline_score=baseline_avg,
        )
        self._logger.log_cycle({
            "loop_id": loop_id,
            "cycle": 0,
            "stage": "baseline",
            "scores": baseline_scores,
            "average": baseline_avg,
        })

        # Keep per-question results from baseline for first tally
        per_question = baseline_result.get("per_question", [])

        # ---------------------------------------------------------------
        # Main loop: cycles 1 .. max_cycles
        # ---------------------------------------------------------------
        max_cycles = self._config.termination.max_cycles

        for cycle in range(1, max_cycles + 1):
            # Check for external stop request
            if self._state.is_stop_requested(loop_id):
                logger.info("Stop requested -- finishing loop at cycle %d", cycle)
                self._state.finish_loop(loop_id, StopReason.MANUAL_STOP)
                return loop_id

            cycle_started = datetime.datetime.utcnow().isoformat()
            cycle_t0 = time.time()
            logger.info("=== Cycle %d / %d ===", cycle, max_cycles)

            # Use seed dataset for cycle 1 if provided
            if cycle == 1 and self._seed_dataset_path:
                logger.info("Using seed dataset: %s", self._seed_dataset_path)
                dataset_path = Path(self._seed_dataset_path)
                tally_metadata = {"seed_dataset": True}
                accepted_count = sum(1 for _ in open(dataset_path))
                logger.info("Seed dataset: %d pairs", accepted_count)
            else:
                # [1] TALLYING
                self._state.update_stage(loop_id, cycle, Stage.TALLYING)
                t0 = time.time()
                failed_questions = [q for q in per_question if not q.get("passed")]
                history = self._logger.get_cycle_history()
                tally_metadata = run_tally(
                    failed_questions,
                    history,
                    model=self._config.tally.model,
                    max_retries=self._config.tally.max_retries,
                    max_tool_calls=self._config.tally.max_tool_calls,
                    timeout_seconds=self._config.tally.timeout_seconds,
                    log_dir=self._config.logging.log_dir,
                    history_window=self._config.tally.history_window,
                )
                logger.info("TALLYING completed in %.1fs -- %d clusters, %d search queries",
                            time.time() - t0,
                            len(tally_metadata.get("clusters", [])),
                            len(tally_metadata.get("search_queries", [])))

                # [2] RETRIEVING
                self._state.update_stage(loop_id, cycle, Stage.RETRIEVING)
                t0 = time.time()
                papers = retrieve_papers(
                    tally_metadata,
                    sources=self._config.retrieval.sources,
                    max_papers_per_cluster=self._config.retrieval.max_papers_per_cluster,
                )
                papers = extract_paper_text(papers)
                logger.info("RETRIEVING completed in %.1fs -- %d papers from %s",
                            time.time() - t0, len(papers), self._config.retrieval.sources)

                # [3] CURATING
                self._state.update_stage(loop_id, cycle, Stage.CURATING)
                t0 = time.time()
                verification_cfg = {
                    "citation_matching": self._config.curation.verification.citation_matching,
                    "min_entailment_ratio": self._config.curation.verification.entailment_min_ratio,
                    "chunk_tracing_threshold": self._config.curation.verification.chunk_similarity_threshold,
                    "embedding_model": self._config.curation.verification.embedding_model,
                }
                accepted, rejects = generate_pairs(
                    papers,
                    tally_metadata,
                    model=self._config.curation.model,
                    min_pairs=self._config.curation.min_pairs_per_cycle,
                    verification_config=verification_cfg,
                )

                dataset_dir = self._checkpoint_dir / f"cycle-{cycle}"
                dataset_dir.mkdir(parents=True, exist_ok=True)
                dataset_path = dataset_dir / "dataset.jsonl"
                rejects_path = dataset_dir / self._config.curation.verification.rejects_log
                save_dataset(accepted, dataset_path, rejects, rejects_path)
                logger.info("CURATING completed in %.1fs -- %d accepted, %d rejected",
                            time.time() - t0, len(accepted), len(rejects))

                # Free curation model VRAM
                unload_all_models()

            # [4] TRAINING
            unload_all_models()  # ensure Ollama VRAM is clear before HF training
            self._state.update_stage(loop_id, cycle, Stage.TRAINING)
            t0 = time.time()
            adapter_path, training_loss = self._run_training(
                str(dataset_path), cycle,
            )
            logger.info("TRAINING completed in %.1fs -- adapter=%s loss=%.4f",
                        time.time() - t0, adapter_path, training_loss)

            # [5] MERGING
            self._state.update_stage(loop_id, cycle, Stage.MERGING)
            t0 = time.time()
            self._current_version += 1
            merged_dir = self._checkpoint_dir / f"base-v{self._current_version}"
            self._run_merge(adapter_path, str(merged_dir))
            merged_model_path = str(merged_dir)
            logger.info("MERGING completed in %.1fs -- merged model at %s",
                        time.time() - t0, merged_model_path)

            # [6] EVALUATING
            unload_all_models()  # ensure Ollama VRAM is clear before HF benchmark
            self._state.update_stage(loop_id, cycle, Stage.EVALUATING)
            t0 = time.time()
            eval_result = run_benchmarks(merged_model_path, suites, batch_size)
            scores = eval_result["scores"]
            current_avg = compute_gate_score(scores)
            per_question = eval_result.get("per_question", [])
            logger.info("EVALUATING completed in %.1fs -- average=%.2f, scores=%s",
                        time.time() - t0, current_avg, scores)
            logger.info("Evaluation: average=%.2f (prev=%.2f)", current_avg, self._previous_average)

            # [7] GATING
            self._state.update_stage(loop_id, cycle, Stage.GATING)
            gate_result = evaluate_gate(
                current_avg,
                self._previous_average,
                threshold=self._config.gate.improvement_threshold,
            )
            logger.info("Gate: passed=%s delta=%.4f", gate_result.passed, gate_result.delta)

            if gate_result.passed:
                self._previous_average = current_avg
                cleanup_checkpoints(
                    self._checkpoint_dir,
                    max_keep=self._config.training.max_checkpoints,
                )
                self._consecutive_failures = 0
                logger.info("Gate PASSED -- model accepted (v%d)", self._current_version)
            else:
                rollback_merge(merged_model_path)
                self._current_version -= 1
                self._consecutive_failures += 1
                merged_model_path = None
                logger.info("Gate FAILED -- rolled back (consecutive=%d)",
                            self._consecutive_failures)

            logger.info("=== Cycle %d completed in %.1fs ===", cycle, time.time() - cycle_t0)

            # Save cycle record
            cycle_record = CycleRecord(
                cycle=cycle,
                benchmark_scores=scores,
                gate_passed=gate_result.passed,
                gate_delta=gate_result.delta,
                consecutive_gate_failures=self._consecutive_failures,
                merged_model_path=merged_model_path,
                tally_metadata=tally_metadata,
                dataset_path=str(dataset_path),
                dataset_size=len(accepted),
                adapter_path=str(adapter_path),
                training_loss=training_loss,
                started_at=cycle_started,
                completed_at=datetime.datetime.utcnow().isoformat(),
            )
            self._state.save_cycle(loop_id, cycle_record)

            self._logger.log_cycle({
                "loop_id": loop_id,
                "cycle": cycle,
                "scores": scores,
                "average": current_avg,
                "gate_passed": gate_result.passed,
                "gate_delta": gate_result.delta,
                "consecutive_failures": self._consecutive_failures,
            })
            self._logger.update_project(
                project_id,
                current_score=current_avg,
                best_score=max(current_avg, self._previous_average),
                total_cycles=cycle,
                successful_merges=(
                    cycle - self._consecutive_failures
                    if gate_result.passed
                    else cycle - self._consecutive_failures - 1
                ),
                failed_gates=self._consecutive_failures,
            )

            # Check termination conditions
            if current_avg >= self._config.termination.target_score and gate_result.passed:
                logger.info("Target score %.2f reached -- stopping",
                            self._config.termination.target_score)
                self._state.finish_loop(loop_id, StopReason.TARGET_REACHED)
                return loop_id

            if self._consecutive_failures >= self._config.gate.fail_cap:
                logger.warning("Fail cap (%d) reached -- escalating",
                               self._config.gate.fail_cap)
                self._handle_fail_cap(
                    loop_id, project_id, cycle, scores, tally_metadata,
                )
                return loop_id

        # Exhausted all cycles
        logger.info("Max cycles (%d) reached -- stopping", max_cycles)
        self._state.finish_loop(loop_id, StopReason.MAX_CYCLES)
        return loop_id

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _run_training(self, dataset_path: str, cycle: int) -> tuple[Path, float]:
        """Run QwenTrainer on the curated dataset.

        Returns:
            Tuple of (adapter_path, final_training_loss).
        """
        from sdgs.web.engine.trainer import QwenTrainer

        output_dir = self._checkpoint_dir / f"training-cycle-{cycle}"
        output_dir.mkdir(parents=True, exist_ok=True)

        trainer = QwenTrainer(
            dataset_path=dataset_path,
            model_config={"model_name": self._base_model_path},
            training_config={
                "output_dir": str(output_dir),
                "num_train_epochs": 1,
            },
        )
        trainer.load_model()
        trainer.prepare_dataset()
        stats = trainer.train()
        adapter_path_str = trainer.save_adapter(str(output_dir))

        training_loss = stats.get("training_loss", 0.0)
        return Path(adapter_path_str), training_loss

    def _run_merge(self, adapter_path: Path, output_dir: str) -> None:
        """Merge LoRA adapter into the base model."""
        from sdgs.web.engine.merge_convert import merge_lora

        merge_lora(
            adapter_path=str(adapter_path),
            base_model=self._base_model_path,
            output_dir=output_dir,
        )

    def _handle_fail_cap(
        self,
        loop_id: str,
        project_id: str,
        cycle: int,
        scores: dict[str, Any],
        tally_metadata: dict[str, Any],
    ) -> None:
        """Build escalation report, send email, and stop the loop."""
        clusters = tally_metadata.get("clusters", [])
        tally_summary = [
            {"cluster": c.get("gap_description", "unknown"),
             "count": len(c.get("affected_questions", []))}
            for c in clusters
        ]

        body = build_report_body(
            project_id=project_id,
            cycle=cycle,
            consecutive_failures=self._consecutive_failures,
            scores=scores,
            tally_summary=tally_summary,
        )

        send_fail_cap_email(
            to_email="admin@ouroborus.local",
            subject=f"[Ouroborus] Fail-cap reached -- project {project_id} cycle {cycle}",
            body=body,
            smtp_host=self._config.gate.smtp_host,
            smtp_port=self._config.gate.smtp_port,
        )

        self._state.finish_loop(loop_id, StopReason.FAIL_CAP)
