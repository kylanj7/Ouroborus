"""Tests for sdgs/loop/state_v2.py -- closed-loop state persistence."""
from __future__ import annotations

import pytest

from sdgs.loop.state_v2 import (
    CycleRecord,
    LoopState,
    LoopStateStore,
    Stage,
    StopReason,
)


# ---------------------------------------------------------------------------
# Enum tests
# ---------------------------------------------------------------------------

def test_stage_enum():
    assert Stage.BASELINE == "baseline"
    assert Stage.TALLYING == "tallying"
    assert Stage.RETRIEVING == "retrieving"
    assert Stage.CURATING == "curating"
    assert Stage.TRAINING == "training"
    assert Stage.MERGING == "merging"
    assert Stage.EVALUATING == "evaluating"
    assert Stage.GATING == "gating"
    assert len(Stage) == 8


def test_stop_reason_enum():
    assert StopReason.TARGET_REACHED == "target_reached"
    assert StopReason.FAIL_CAP == "fail_cap"
    assert StopReason.MAX_CYCLES == "max_cycles"
    assert StopReason.MANUAL_STOP == "manual_stop"
    assert StopReason.ABORTED == "aborted"
    assert len(StopReason) == 5


# ---------------------------------------------------------------------------
# Store tests
# ---------------------------------------------------------------------------

@pytest.fixture
def store(tmp_path):
    s = LoopStateStore(db_path=tmp_path / "test_state.db")
    yield s
    s.close()


def test_create_and_get_loop(store):
    config = {"target_score": 0.9, "max_cycles": 5}
    loop = store.create_loop("loop-abc", config)

    assert isinstance(loop, LoopState)
    assert loop.loop_id == "loop-abc"
    assert loop.status == "running"
    assert loop.current_cycle == 0
    assert loop.current_stage == Stage.BASELINE
    assert loop.stop_reason is None
    assert loop.stop_requested is False
    assert loop.config_snapshot == config
    assert loop.created_at != ""
    assert loop.updated_at != ""
    assert loop.cycles == []

    retrieved = store.get_loop("loop-abc")
    assert retrieved is not None
    assert retrieved.loop_id == "loop-abc"
    assert retrieved.config_snapshot == config
    assert retrieved.cycles == []


def test_get_loop_returns_none_for_missing(store):
    assert store.get_loop("nonexistent") is None


def test_save_and_get_cycle_record(store):
    store.create_loop("loop-xyz", {})

    record = CycleRecord(
        cycle=1,
        benchmark_scores={"mmlu": 0.72, "hellaswag": 0.65},
        gate_passed=True,
        gate_delta=0.03,
        consecutive_gate_failures=0,
        merged_model_path="/models/merged-1",
        tally_metadata={"source": "arxiv", "count": 120},
        dataset_path="/data/cycle-1.jsonl",
        dataset_size=120,
        adapter_path="/adapters/cycle-1",
        training_loss=0.42,
        started_at="2026-03-15T00:00:00",
        completed_at="2026-03-15T01:00:00",
    )
    store.save_cycle("loop-xyz", record)

    state = store.get_loop("loop-xyz")
    assert state is not None
    assert len(state.cycles) == 1

    r = state.cycles[0]
    assert r.cycle == 1
    assert r.benchmark_scores == {"mmlu": 0.72, "hellaswag": 0.65}
    assert r.gate_passed is True
    assert r.gate_delta == pytest.approx(0.03)
    assert r.consecutive_gate_failures == 0
    assert r.merged_model_path == "/models/merged-1"
    assert r.tally_metadata == {"source": "arxiv", "count": 120}
    assert r.dataset_path == "/data/cycle-1.jsonl"
    assert r.dataset_size == 120
    assert r.adapter_path == "/adapters/cycle-1"
    assert r.training_loss == pytest.approx(0.42)
    assert r.started_at == "2026-03-15T00:00:00"
    assert r.completed_at == "2026-03-15T01:00:00"


def test_save_cycle_with_null_gate_passed(store):
    store.create_loop("loop-null", {})

    record = CycleRecord(
        cycle=0,
        benchmark_scores={},
        gate_passed=None,
        gate_delta=0.0,
        consecutive_gate_failures=0,
        merged_model_path=None,
        tally_metadata={},
        dataset_path=None,
        dataset_size=0,
        adapter_path=None,
        training_loss=None,
        started_at=None,
        completed_at=None,
    )
    store.save_cycle("loop-null", record)

    state = store.get_loop("loop-null")
    assert state is not None
    assert state.cycles[0].gate_passed is None
    assert state.cycles[0].training_loss is None


def test_consecutive_gate_failures(store):
    store.create_loop("loop-fail", {})

    for i in range(3):
        record = CycleRecord(
            cycle=i,
            benchmark_scores={"mmlu": 0.50 + i * 0.01},
            gate_passed=False,
            gate_delta=-0.01,
            consecutive_gate_failures=i + 1,
            merged_model_path=None,
            tally_metadata={},
            dataset_path=None,
            dataset_size=0,
            adapter_path=None,
            training_loss=None,
            started_at=None,
            completed_at=None,
        )
        store.save_cycle("loop-fail", record)

    state = store.get_loop("loop-fail")
    assert state is not None
    assert len(state.cycles) == 3
    assert state.cycles[0].consecutive_gate_failures == 1
    assert state.cycles[1].consecutive_gate_failures == 2
    assert state.cycles[2].consecutive_gate_failures == 3
    # all gates failed
    assert all(c.gate_passed is False for c in state.cycles)


def test_update_stage(store):
    store.create_loop("loop-stage", {})
    store.update_stage("loop-stage", cycle=1, stage=Stage.TRAINING)

    state = store.get_loop("loop-stage")
    assert state is not None
    assert state.current_cycle == 1
    assert state.current_stage == Stage.TRAINING


def test_finish_loop(store):
    store.create_loop("loop-done", {})
    store.finish_loop("loop-done", StopReason.TARGET_REACHED)

    state = store.get_loop("loop-done")
    assert state is not None
    assert state.status == "stopped"
    assert state.stop_reason == StopReason.TARGET_REACHED


def test_request_stop_and_check(store):
    store.create_loop("loop-stop", {})
    assert store.is_stop_requested("loop-stop") is False

    store.request_stop("loop-stop")
    assert store.is_stop_requested("loop-stop") is True

    state = store.get_loop("loop-stop")
    assert state is not None
    assert state.stop_requested is True


def test_get_active_loop(store):
    assert store.get_active_loop() is None

    store.create_loop("loop-active", {"x": 1})
    active = store.get_active_loop()
    assert active is not None
    assert active.loop_id == "loop-active"

    store.finish_loop("loop-active", StopReason.MANUAL_STOP)
    assert store.get_active_loop() is None
