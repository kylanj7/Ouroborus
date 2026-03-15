"""Quality gate for the closed-loop evolution system.

Compares evaluation scores, decides whether a merged model should be accepted,
and manages checkpoint directory hygiene.
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class GateResult:
    passed: bool
    delta: float
    current_average: float
    previous_average: float


def evaluate_gate(
    current_average: float,
    previous_average: float,
    threshold: float = 0.5,
) -> GateResult:
    """Compare evaluation scores and decide whether the gate passes.

    The gate passes when ``current_average - previous_average >= threshold``.
    """
    delta = current_average - previous_average
    passed = delta >= threshold
    return GateResult(
        passed=passed,
        delta=delta,
        current_average=current_average,
        previous_average=previous_average,
    )


def cleanup_checkpoints(checkpoint_dir: Path, max_keep: int = 5) -> None:
    """Remove oldest checkpoints beyond ``max_keep``, always preserving base-v0.

    Checkpoints are directories named ``base-v{N}``.  Sorting is done by
    version number (``N``).  ``base-v0`` is the original checkpoint and is
    never deleted regardless of ``max_keep``.
    """
    candidates: list[tuple[int, Path]] = []
    for entry in checkpoint_dir.iterdir():
        if not entry.is_dir():
            continue
        name = entry.name
        if not name.startswith("base-v"):
            continue
        suffix = name[len("base-v"):]
        if not suffix.isdigit():
            continue
        version = int(suffix)
        if version == 0:
            continue  # never delete base-v0
        candidates.append((version, entry))

    # Sort ascending so we can drop oldest first
    candidates.sort(key=lambda t: t[0])

    excess = len(candidates) - max_keep
    if excess <= 0:
        return

    for _, path in candidates[:excess]:
        shutil.rmtree(path)


def rollback_merge(merged_model_path: str) -> None:
    """Delete a merged model directory."""
    shutil.rmtree(merged_model_path)
