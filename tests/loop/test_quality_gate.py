"""Tests for sdgs.loop.quality_gate."""
from __future__ import annotations

import pytest
from pathlib import Path

from sdgs.loop.quality_gate import GateResult, evaluate_gate, cleanup_checkpoints, rollback_merge


# ---------------------------------------------------------------------------
# test_gate_passes_on_improvement
# ---------------------------------------------------------------------------

def test_gate_passes_on_improvement():
    """Gate passes when delta exactly meets threshold."""
    result = evaluate_gate(current_average=50.5, previous_average=50.0, threshold=0.5)
    assert isinstance(result, GateResult)
    assert result.passed is True
    assert result.delta == pytest.approx(0.5)
    assert result.current_average == 50.5
    assert result.previous_average == 50.0


# ---------------------------------------------------------------------------
# test_gate_fails_on_insufficient
# ---------------------------------------------------------------------------

def test_gate_fails_on_insufficient():
    """Gate fails when improvement is below threshold."""
    result = evaluate_gate(current_average=50.3, previous_average=50.0, threshold=0.5)
    assert result.passed is False
    assert result.delta == pytest.approx(0.3)
    assert result.current_average == 50.3
    assert result.previous_average == 50.0


# ---------------------------------------------------------------------------
# test_gate_fails_on_regression
# ---------------------------------------------------------------------------

def test_gate_fails_on_regression():
    """Gate fails when score regresses."""
    result = evaluate_gate(current_average=49.0, previous_average=50.0, threshold=0.5)
    assert result.passed is False
    assert result.delta == pytest.approx(-1.0)
    assert result.current_average == 49.0
    assert result.previous_average == 50.0


# ---------------------------------------------------------------------------
# test_checkpoint_cleanup
# ---------------------------------------------------------------------------

def test_checkpoint_cleanup(tmp_path: Path):
    """Cleanup keeps v0 always and last max_keep checkpoints."""
    # Create base-v0 through base-v7 (8 dirs total)
    for i in range(8):
        (tmp_path / f"base-v{i}").mkdir()

    cleanup_checkpoints(tmp_path, max_keep=5)

    remaining = {d.name for d in tmp_path.iterdir() if d.is_dir()}

    # v0 must always be kept
    assert "base-v0" in remaining

    # The last 5 non-v0 versions are v3 through v7
    for i in range(3, 8):
        assert f"base-v{i}" in remaining, f"base-v{i} should be kept"

    # v1 and v2 should be deleted
    assert "base-v1" not in remaining
    assert "base-v2" not in remaining

    # Total kept: v0 + v3..v7 = 6 dirs
    assert len(remaining) == 6


# ---------------------------------------------------------------------------
# test_rollback_deletes_merged
# ---------------------------------------------------------------------------

def test_rollback_deletes_merged(tmp_path: Path):
    """rollback_merge deletes the target directory entirely."""
    merged_dir = tmp_path / "merged-model"
    merged_dir.mkdir()
    (merged_dir / "config.json").write_text("{}")

    assert merged_dir.exists()
    rollback_merge(str(merged_dir))
    assert not merged_dir.exists()
