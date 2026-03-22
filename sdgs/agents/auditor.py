"""Auditor agent -- tracks scores, VRAM events, and pain points across the run.

Writes evolution_progress.md as a living document, rewritten on every
significant event from the EvolutionRecord state.
"""
from __future__ import annotations

import datetime
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sdgs.loop.state_v2 import LoopStateStore, CycleRecord

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
PROGRESS_FILE = PROJECT_ROOT / "evolution_progress.md"


@dataclass
class CycleSnapshot:
    """Tracks a single cycle's metrics and events."""

    cycle: int
    scores: dict[str, float] | None = None
    gate_passed: bool | None = None
    gate_delta: float = 0.0
    dataset_size: int = 0
    training_loss: float | None = None
    config_adjustments: list[dict[str, Any]] = field(default_factory=list)
    pain_points: list[str] = field(default_factory=list)
    tally_sanitized: bool = False
    sanitizer_strategy: str = ""
    started_at: str = ""
    completed_at: str = ""


@dataclass
class EvolutionRecord:
    """Top-level state for the entire agent-managed run."""

    loop_id: str = ""
    baseline_scores: dict[str, float] = field(default_factory=dict)
    baseline_average: float = 0.0
    target: float = 85.0
    cycles: list[CycleSnapshot] = field(default_factory=list)
    vram_events: list[str] = field(default_factory=list)
    vram_snapshots: list[dict[str, Any]] = field(default_factory=list)
    total_fixer_interventions: int = 0
    started_at: str = ""
    status: str = "running"


class Auditor:
    """Observes loop events and maintains evolution_progress.md."""

    def __init__(
        self,
        state_store: LoopStateStore,
        output_path: Path | None = None,
    ):
        self._store = state_store
        self._output = output_path or PROGRESS_FILE
        self._record = EvolutionRecord()
        self._current_snapshot: CycleSnapshot | None = None

    @property
    def record(self) -> EvolutionRecord:
        return self._record

    # ------------------------------------------------------------------
    # Bootstrap -- pull baseline from state DB
    # ------------------------------------------------------------------

    def bootstrap(self, loop_id: str) -> None:
        """Load baseline scores from the state DB for a given loop."""
        self._record.loop_id = loop_id
        self._record.started_at = datetime.datetime.utcnow().isoformat()

        loop_state = self._store.get_loop(loop_id)
        if loop_state and loop_state.cycles:
            baseline = loop_state.cycles[0]
            if baseline.cycle == 0:
                scores = {
                    k: v
                    for k, v in baseline.benchmark_scores.items()
                    if k != "average"
                }
                self._record.baseline_scores = scores
                avg = baseline.benchmark_scores.get("average")
                if avg is not None:
                    self._record.baseline_average = avg
                else:
                    vals = [v for v in scores.values() if isinstance(v, (int, float))]
                    self._record.baseline_average = sum(vals) / len(vals) if vals else 0.0

        if loop_state and loop_state.config_snapshot:
            target = (
                loop_state.config_snapshot
                .get("termination", {})
                .get("target_score", 85.0)
            )
            self._record.target = target

        self._write()

    # ------------------------------------------------------------------
    # Callbacks -- called by the Watcher
    # ------------------------------------------------------------------

    def on_stage(self, stage: str, cycle: int) -> None:
        """Record a stage transition. Creates a new CycleSnapshot on cycle advance."""
        if stage == "baseline":
            return

        if self._current_snapshot is None or self._current_snapshot.cycle != cycle:
            self._current_snapshot = CycleSnapshot(
                cycle=cycle,
                started_at=datetime.datetime.utcnow().isoformat(),
            )
            self._record.cycles.append(self._current_snapshot)

        self._write()

    def on_training_log(self, line: str) -> None:
        """Extract loss values from training log lines."""
        if self._current_snapshot is None:
            return

        lower = line.lower()
        for marker in ("loss:", "train_loss:", "training_loss:"):
            if marker in lower:
                idx = lower.index(marker) + len(marker)
                rest = line[idx:].strip().split()[0].rstrip(",")
                try:
                    self._current_snapshot.training_loss = float(rest)
                except ValueError:
                    pass
                return

    def on_gate_result(self, loop_id: str) -> None:
        """Pull the latest cycle record from state DB and update the snapshot."""
        loop_state = self._store.get_loop(loop_id)
        if not loop_state or not loop_state.cycles:
            return

        latest = loop_state.cycles[-1]
        if latest.cycle == 0:
            return

        snap = self._find_snapshot(latest.cycle)
        if snap is None:
            return

        scores = {
            k: v for k, v in latest.benchmark_scores.items() if k != "average"
        }
        snap.scores = scores
        snap.gate_passed = latest.gate_passed
        snap.gate_delta = latest.gate_delta
        snap.dataset_size = latest.dataset_size
        if latest.training_loss is not None:
            snap.training_loss = latest.training_loss
        snap.completed_at = datetime.datetime.utcnow().isoformat()

        if latest.gate_passed:
            logger.info(
                "Cycle %d PASSED gate (delta=%.2f pp)", latest.cycle, latest.gate_delta
            )
        else:
            logger.info(
                "Cycle %d FAILED gate (delta=%.2f pp)", latest.cycle, latest.gate_delta
            )

        self._write()

    def on_fixer_intervention(self, action: str, details: dict[str, Any]) -> None:
        """Record a Fixer action (config change, sanitizer invocation, etc.)."""
        self._record.total_fixer_interventions += 1

        if self._current_snapshot is None:
            return

        if action == "config_adjustment":
            self._current_snapshot.config_adjustments.append(details)
        elif action == "tally_sanitized":
            self._current_snapshot.tally_sanitized = True
            self._current_snapshot.sanitizer_strategy = details.get("strategy", "")
        else:
            self._current_snapshot.pain_points.append(
                f"{action}: {details.get('reason', '')}"
            )

        self._write()

    def on_vram_event(self, event_text: str) -> None:
        """Append a VRAM load/unload event to the trace."""
        ts = datetime.datetime.utcnow().strftime("%H:%M:%S")
        self._record.vram_events.append(f"[{ts}] {event_text}")
        # Don't rewrite the file on every VRAM event -- too noisy.
        # The file will be updated on the next stage transition or gate result.

    def capture_vram_snapshot(self, label: str) -> None:
        """Query nvidia-smi for per-GPU memory usage and record a snapshot.

        This runs nvidia-smi as a subprocess -- no torch/CUDA import needed.
        Safe to call from the agent process (CPU-only).
        """
        snapshot = _query_gpu_memory()
        if snapshot:
            ts = datetime.datetime.utcnow().strftime("%H:%M:%S")
            snapshot["timestamp"] = ts
            snapshot["label"] = label
            self._record.vram_snapshots.append(snapshot)

    def finalize(self, status: str = "completed") -> Path:
        """Write the final summary and return the output path."""
        self._record.status = status
        self._write()
        logger.info("Evolution progress written to %s", self._output)
        return self._output

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _find_snapshot(self, cycle: int) -> CycleSnapshot | None:
        for snap in self._record.cycles:
            if snap.cycle == cycle:
                return snap
        return None

    def _write(self) -> None:
        """Full rewrite of evolution_progress.md from EvolutionRecord state."""
        r = self._record
        lines: list[str] = []

        # Header
        lines.append("# Evolution Loop Progress\n")
        lines.append("## Run Info")
        lines.append(f"- Loop ID: {r.loop_id}")
        lines.append(f"- Started: {r.started_at}")
        lines.append(f"- Target: {r.target}% | Baseline: {r.baseline_average}%")
        lines.append(f"- Status: {r.status}")
        lines.append("")

        # Baseline
        lines.append("## Baseline Scores")
        lines.append("| Benchmark | Score |")
        lines.append("|---|---|")
        for name, score in r.baseline_scores.items():
            lines.append(f"| {_format_benchmark_name(name)} | {score}% |")
        lines.append(f"| Average | {r.baseline_average}% |")
        lines.append("")

        # Cycles
        for snap in r.cycles:
            lines.append(f"## Cycle {snap.cycle}")

            if snap.scores:
                avg = _compute_average(snap.scores)
                delta_from_baseline = avg - r.baseline_average
                lines.append(f"- Scores: {_format_scores(snap.scores)}")
                lines.append(f"- Average: {avg:.1f}% ({delta_from_baseline:+.1f} pp from baseline)")
            else:
                lines.append("- Scores: (pending)")

            if snap.gate_passed is not None:
                result = "PASSED" if snap.gate_passed else "FAILED"
                lines.append(f"- Gate: {result} (delta={snap.gate_delta:.2f}, threshold=0.5)")

            lines.append(f"- Dataset Size: {snap.dataset_size} pairs")

            if snap.training_loss is not None:
                lines.append(f"- Training Loss: {snap.training_loss:.4f}")

            if snap.tally_sanitized:
                lines.append(
                    f"- Tally Sanitized: Yes ({snap.sanitizer_strategy})"
                )

            if snap.config_adjustments:
                lines.append("- Config Adjustments:")
                for adj in snap.config_adjustments:
                    param = adj.get("parameter", "?")
                    old = adj.get("old", "?")
                    new = adj.get("new", "?")
                    reason = adj.get("reason", "")
                    lines.append(f"  - {param}: {old} -> {new} ({reason})")

            if snap.pain_points:
                lines.append("- Pain Points:")
                for pp in snap.pain_points:
                    lines.append(f"  - {pp}")

            lines.append("")

        # VRAM Trace
        if r.vram_events:
            lines.append("## VRAM Trace")
            for ev in r.vram_events:
                lines.append(f"- {ev}")
            lines.append("")

        # VRAM Snapshots
        if r.vram_snapshots:
            lines.append("## VRAM Snapshots")
            lines.append("| Time | Label | GPU 0 (MB) | GPU 1 (MB) | GPU 2 (MB) | Total (MB) |")
            lines.append("|---|---|---|---|---|---|")
            for snap in r.vram_snapshots:
                ts = snap.get("timestamp", "")
                label = snap.get("label", "")
                gpus = snap.get("gpus", [])
                gpu_vals = [str(g.get("used_mb", 0)) for g in gpus]
                # Pad to 3 GPUs
                while len(gpu_vals) < 3:
                    gpu_vals.append("-")
                total = sum(g.get("used_mb", 0) for g in gpus)
                lines.append(f"| {ts} | {label} | {gpu_vals[0]} | {gpu_vals[1]} | {gpu_vals[2]} | {total} |")
            lines.append("")

        # Summary
        completed = sum(1 for s in r.cycles if s.gate_passed is True)
        final_avg = None
        if r.cycles:
            last_with_scores = None
            for s in reversed(r.cycles):
                if s.scores:
                    last_with_scores = s
                    break
            if last_with_scores and last_with_scores.scores:
                final_avg = _compute_average(last_with_scores.scores)

        lines.append("## Summary")
        lines.append(f"- Cycles Completed: {completed}")
        if final_avg is not None:
            delta = final_avg - r.baseline_average
            lines.append(
                f"- Final Average: {final_avg:.1f}% "
                f"(baseline: {r.baseline_average}%, delta: {delta:+.1f} pp)"
            )
        lines.append(f"- Fixer Interventions: {r.total_fixer_interventions}")
        lines.append(f"- Status: {r.status}")
        lines.append("")

        self._output.write_text("\n".join(lines), encoding="utf-8")


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _format_benchmark_name(name: str) -> str:
    """Turn 'arc_challenge' into 'ARC Challenge'."""
    return name.replace("_", " ").title()


def _format_scores(scores: dict[str, float]) -> str:
    parts = []
    for name, val in scores.items():
        parts.append(f"{_format_benchmark_name(name)} {val:.1f}%")
    return ", ".join(parts)


def _compute_average(scores: dict[str, float]) -> float:
    vals = [v for v in scores.values() if isinstance(v, (int, float))]
    return sum(vals) / len(vals) if vals else 0.0


def _query_gpu_memory() -> dict[str, Any] | None:
    """Query nvidia-smi for per-GPU memory usage. No torch import needed.

    Returns dict with "gpus" list, each containing "index", "used_mb", "total_mb",
    "free_mb", and "name". Returns None if nvidia-smi is unavailable.
    """
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.used,memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None

        gpus = []
        for line in result.stdout.strip().split("\n"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 5:
                gpus.append({
                    "index": int(parts[0]),
                    "name": parts[1],
                    "used_mb": int(parts[2]),
                    "total_mb": int(parts[3]),
                    "free_mb": int(parts[4]),
                })
        return {"gpus": gpus}
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
