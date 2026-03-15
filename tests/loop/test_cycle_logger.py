"""Tests for sdgs.loop.cycle_logger."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from sdgs.loop.cycle_logger import CycleLogger


# ---------------------------------------------------------------------------
# test_append_cycle_log
# ---------------------------------------------------------------------------

def test_append_cycle_log(tmp_path: Path):
    """log_cycle appends a JSON line; file exists and can be parsed back."""
    logger = CycleLogger(log_dir=tmp_path)
    entry = {"cycle": 1, "score": 72.5, "model": "qwen2.5-7b"}
    logger.log_cycle(entry)

    log_file = tmp_path / "loop_log.jsonl"
    assert log_file.exists()

    lines = log_file.read_text().strip().splitlines()
    assert len(lines) == 1

    parsed = json.loads(lines[0])
    assert parsed["cycle"] == 1
    assert parsed["score"] == 72.5
    assert parsed["model"] == "qwen2.5-7b"
    assert "timestamp" in parsed


# ---------------------------------------------------------------------------
# test_create_project
# ---------------------------------------------------------------------------

def test_create_project(tmp_path: Path):
    """create_project stores all required fields in the project log."""
    logger = CycleLogger(log_dir=tmp_path)
    logger.create_project(
        project_id="physics-v1",
        domain="physics",
        base_model="qwen2.5-7b",
        baseline_score=68.0,
    )

    projects = logger._load_projects()
    assert "physics-v1" in projects

    p = projects["physics-v1"]
    assert p["domain"] == "physics"
    assert p["base_model"] == "qwen2.5-7b"
    assert p["baseline_score"] == 68.0
    assert "started" in p
    assert p["current_score"] == 68.0
    assert p["best_score"] == 68.0
    assert p["total_cycles"] == 0
    assert p["successful_merges"] == 0
    assert p["failed_gates"] == 0
    assert p["current_base_version"] is None
    assert p["status"] == "active"


# ---------------------------------------------------------------------------
# test_update_project
# ---------------------------------------------------------------------------

def test_update_project(tmp_path: Path):
    """update_project modifies existing project fields."""
    logger = CycleLogger(log_dir=tmp_path)
    logger.create_project(
        project_id="physics-v1",
        domain="physics",
        base_model="qwen2.5-7b",
        baseline_score=68.0,
    )

    logger.update_project(
        "physics-v1",
        current_score=74.3,
        total_cycles=3,
        successful_merges=2,
        status="complete",
    )

    projects = logger._load_projects()
    p = projects["physics-v1"]
    assert p["current_score"] == 74.3
    assert p["total_cycles"] == 3
    assert p["successful_merges"] == 2
    assert p["status"] == "complete"
    # Fields not updated remain unchanged
    assert p["domain"] == "physics"
    assert p["baseline_score"] == 68.0
