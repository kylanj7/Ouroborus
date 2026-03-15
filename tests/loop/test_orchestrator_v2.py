"""Tests for sdgs/loop/orchestrator_v2.py -- closed-loop orchestrator."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from sdgs.loop.config_v2 import (
    BenchmarkConfig,
    ClosedLoopConfig,
    CurationConfig,
    GateConfig,
    LoggingConfig,
    RetrievalConfig,
    TallyConfig,
    TerminationConfig,
    TrainingStrategyConfig,
    VerificationConfig,
)
from sdgs.loop.orchestrator_v2 import ClosedLoopOrchestrator
from sdgs.loop.quality_gate import GateResult
from sdgs.loop.state_v2 import LoopStateStore, StopReason


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_config(tmp_path: Path, max_cycles: int = 1, fail_cap: int = 3) -> ClosedLoopConfig:
    """Build a ClosedLoopConfig pointing at tmp_path directories."""
    return ClosedLoopConfig(
        gate=GateConfig(improvement_threshold=0.5, fail_cap=fail_cap),
        training=TrainingStrategyConfig(
            base_model="test-model",
            checkpoint_dir=str(tmp_path / "checkpoints"),
            max_checkpoints=5,
        ),
        benchmarks=BenchmarkConfig(suites=["test_suite"], batch_size=1),
        tally=TallyConfig(model="test-tally", max_retries=1),
        curation=CurationConfig(
            model="test-curation",
            min_pairs_per_cycle=10,
            verification=VerificationConfig(),
        ),
        retrieval=RetrievalConfig(sources=["arxiv"], max_papers_per_cluster=5),
        logging=LoggingConfig(log_dir=str(tmp_path / "logs")),
        termination=TerminationConfig(target_score=85.0, max_cycles=max_cycles),
    )


def _benchmark_result(avg: float, per_question: list | None = None) -> dict:
    """Create a mock benchmark result dict."""
    return {
        "scores": {"test_suite": avg, "average": avg},
        "per_question": per_question or [
            {"task": "test_suite", "question": "q1", "model_answer": "a",
             "correct_answer": "b", "passed": False},
        ],
        "raw": {},
    }


# ---------------------------------------------------------------------------
# Patch targets (module-level functions used by the orchestrator)
# ---------------------------------------------------------------------------

_PATCH_PREFIX = "sdgs.loop.orchestrator_v2"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_orchestrator_baseline_and_one_cycle(tmp_path):
    """Mock all stages, verify orchestrator runs baseline + 1 cycle that passes gate."""
    config = _make_config(tmp_path, max_cycles=1)
    db_path = tmp_path / "state.db"

    # Benchmark results: baseline=60, post-training=65 (improvement of 5, passes 0.5 threshold)
    baseline_result = _benchmark_result(60.0)
    cycle1_result = _benchmark_result(65.0, per_question=[
        {"task": "test_suite", "question": "q1", "model_answer": "a",
         "correct_answer": "a", "passed": True},
    ])

    adapter_path = tmp_path / "checkpoints" / "training-cycle-1" / "final_adapter"

    with (
        patch(f"{_PATCH_PREFIX}.run_benchmarks", side_effect=[baseline_result, cycle1_result]) as mock_bench,
        patch(f"{_PATCH_PREFIX}.run_tally", return_value={
            "clusters": [{"gap_description": "physics", "affected_questions": ["q1"]}],
            "search_queries": ["quantum mechanics"],
            "generation_guidance": "Focus on physics.",
        }) as mock_tally,
        patch(f"{_PATCH_PREFIX}.retrieve_papers", return_value=[
            {"paper_id": "p1", "title": "Physics Paper", "text": "content"},
        ]) as mock_retrieve,
        patch(f"{_PATCH_PREFIX}.extract_paper_text", side_effect=lambda p: p) as mock_extract,
        patch(f"{_PATCH_PREFIX}.generate_pairs", return_value=(
            [{"instruction": "q", "response": "a"}] * 10, [],
        )) as mock_gen,
        patch(f"{_PATCH_PREFIX}.save_dataset", return_value=Path("dataset.jsonl")) as mock_save,
        patch(f"{_PATCH_PREFIX}.unload_model") as mock_unload,
        patch(f"{_PATCH_PREFIX}.evaluate_gate", return_value=GateResult(
            passed=True, delta=5.0, current_average=65.0, previous_average=60.0,
        )) as mock_gate,
        patch(f"{_PATCH_PREFIX}.cleanup_checkpoints") as mock_cleanup,
        patch(f"{_PATCH_PREFIX}.rollback_merge") as mock_rollback,
    ):
        orch = ClosedLoopOrchestrator(config=config, state_db=db_path)

        # Patch _run_training and _run_merge on the instance to avoid heavy imports
        orch._run_training = MagicMock(return_value=(adapter_path, 0.42))
        orch._run_merge = MagicMock()

        loop_id = orch.run(loop_id="test01")

    assert loop_id == "test01"

    # Verify benchmarks called twice: baseline + evaluation
    assert mock_bench.call_count == 2

    # Verify tally, retrieval, curation each called once
    mock_tally.assert_called_once()
    mock_retrieve.assert_called_once()
    mock_extract.assert_called_once()
    mock_gen.assert_called_once()
    mock_save.assert_called_once()

    # Verify training and merge
    orch._run_training.assert_called_once()
    orch._run_merge.assert_called_once()

    # Verify gate passed -- cleanup called, rollback not called
    mock_gate.assert_called_once()
    mock_cleanup.assert_called_once()
    mock_rollback.assert_not_called()

    # Verify VRAM cleanup for curation model
    mock_unload.assert_called_once_with("test-curation")

    # Verify state store has cycle 0 (baseline) and cycle 1
    store = LoopStateStore(db_path=db_path)
    loop_state = store.get_loop("test01")
    assert loop_state is not None
    assert len(loop_state.cycles) == 2

    cycle_0 = loop_state.cycles[0]
    assert cycle_0.cycle == 0
    assert cycle_0.gate_passed is None  # baseline has no gate

    cycle_1 = loop_state.cycles[1]
    assert cycle_1.cycle == 1
    assert cycle_1.gate_passed is True
    assert cycle_1.training_loss == 0.42

    # Loop should have finished with MAX_CYCLES (1 cycle done)
    assert loop_state.stop_reason == StopReason.MAX_CYCLES
    store.close()


def test_orchestrator_gate_failure_rollback(tmp_path):
    """Verify rollback on gate failure and consecutive_gate_failures increment."""
    config = _make_config(tmp_path, max_cycles=1)
    db_path = tmp_path / "state.db"

    baseline_result = _benchmark_result(60.0)
    cycle1_result = _benchmark_result(60.1)  # tiny improvement, below 0.5 threshold

    adapter_path = tmp_path / "checkpoints" / "training-cycle-1" / "final_adapter"

    with (
        patch(f"{_PATCH_PREFIX}.run_benchmarks", side_effect=[baseline_result, cycle1_result]),
        patch(f"{_PATCH_PREFIX}.run_tally", return_value={
            "clusters": [], "search_queries": ["test"], "generation_guidance": "test",
        }),
        patch(f"{_PATCH_PREFIX}.retrieve_papers", return_value=[
            {"paper_id": "p1", "title": "Paper", "text": "text"},
        ]),
        patch(f"{_PATCH_PREFIX}.extract_paper_text", side_effect=lambda p: p),
        patch(f"{_PATCH_PREFIX}.generate_pairs", return_value=(
            [{"instruction": "q", "response": "a"}] * 10, [],
        )),
        patch(f"{_PATCH_PREFIX}.save_dataset", return_value=Path("dataset.jsonl")),
        patch(f"{_PATCH_PREFIX}.unload_model"),
        patch(f"{_PATCH_PREFIX}.evaluate_gate", return_value=GateResult(
            passed=False, delta=0.1, current_average=60.1, previous_average=60.0,
        )) as mock_gate,
        patch(f"{_PATCH_PREFIX}.cleanup_checkpoints") as mock_cleanup,
        patch(f"{_PATCH_PREFIX}.rollback_merge") as mock_rollback,
    ):
        orch = ClosedLoopOrchestrator(config=config, state_db=db_path)
        orch._run_training = MagicMock(return_value=(adapter_path, 0.5))
        orch._run_merge = MagicMock()

        loop_id = orch.run(loop_id="test02")

    assert loop_id == "test02"

    # Gate failed -- rollback called, cleanup NOT called
    mock_gate.assert_called_once()
    mock_rollback.assert_called_once()
    mock_cleanup.assert_not_called()

    # Verify state
    store = LoopStateStore(db_path=db_path)
    loop_state = store.get_loop("test02")
    assert loop_state is not None
    assert len(loop_state.cycles) == 2

    cycle_1 = loop_state.cycles[1]
    assert cycle_1.gate_passed is False
    assert cycle_1.consecutive_gate_failures == 1
    assert cycle_1.merged_model_path is None  # rolled back
    store.close()


def test_orchestrator_fail_cap_triggers_email(tmp_path):
    """Verify that reaching the fail cap sends an email and stops the loop."""
    # fail_cap=1 so a single failure triggers escalation
    config = _make_config(tmp_path, max_cycles=5, fail_cap=1)
    db_path = tmp_path / "state.db"

    baseline_result = _benchmark_result(60.0)
    cycle1_result = _benchmark_result(59.0)  # worse than baseline

    adapter_path = tmp_path / "checkpoints" / "training-cycle-1" / "final_adapter"

    with (
        patch(f"{_PATCH_PREFIX}.run_benchmarks", side_effect=[baseline_result, cycle1_result]),
        patch(f"{_PATCH_PREFIX}.run_tally", return_value={
            "clusters": [{"gap_description": "gap1", "affected_questions": ["q"]}],
            "search_queries": ["test"],
            "generation_guidance": "test",
        }),
        patch(f"{_PATCH_PREFIX}.retrieve_papers", return_value=[
            {"paper_id": "p1", "title": "Paper", "text": "text"},
        ]),
        patch(f"{_PATCH_PREFIX}.extract_paper_text", side_effect=lambda p: p),
        patch(f"{_PATCH_PREFIX}.generate_pairs", return_value=(
            [{"instruction": "q", "response": "a"}] * 10, [],
        )),
        patch(f"{_PATCH_PREFIX}.save_dataset", return_value=Path("dataset.jsonl")),
        patch(f"{_PATCH_PREFIX}.unload_model"),
        patch(f"{_PATCH_PREFIX}.evaluate_gate", return_value=GateResult(
            passed=False, delta=-1.0, current_average=59.0, previous_average=60.0,
        )),
        patch(f"{_PATCH_PREFIX}.cleanup_checkpoints"),
        patch(f"{_PATCH_PREFIX}.rollback_merge"),
        patch(f"{_PATCH_PREFIX}.build_report_body", return_value="report") as mock_report,
        patch(f"{_PATCH_PREFIX}.send_fail_cap_email") as mock_email,
    ):
        orch = ClosedLoopOrchestrator(config=config, state_db=db_path)
        orch._run_training = MagicMock(return_value=(adapter_path, 0.5))
        orch._run_merge = MagicMock()

        loop_id = orch.run(loop_id="test03")

    assert loop_id == "test03"

    # Email should have been sent
    mock_report.assert_called_once()
    mock_email.assert_called_once()

    # Verify stop reason is FAIL_CAP
    store = LoopStateStore(db_path=db_path)
    loop_state = store.get_loop("test03")
    assert loop_state is not None
    assert loop_state.stop_reason == StopReason.FAIL_CAP
    store.close()


def test_orchestrator_target_reached_stops(tmp_path):
    """Verify that reaching the target score stops the loop early."""
    config = _make_config(tmp_path, max_cycles=5)
    # Target is 85.0
    db_path = tmp_path / "state.db"

    baseline_result = _benchmark_result(60.0)
    # Post-training score exceeds the target
    cycle1_result = _benchmark_result(90.0)

    adapter_path = tmp_path / "checkpoints" / "training-cycle-1" / "final_adapter"

    with (
        patch(f"{_PATCH_PREFIX}.run_benchmarks", side_effect=[baseline_result, cycle1_result]),
        patch(f"{_PATCH_PREFIX}.run_tally", return_value={
            "clusters": [], "search_queries": ["test"], "generation_guidance": "test",
        }),
        patch(f"{_PATCH_PREFIX}.retrieve_papers", return_value=[
            {"paper_id": "p1", "title": "Paper", "text": "text"},
        ]),
        patch(f"{_PATCH_PREFIX}.extract_paper_text", side_effect=lambda p: p),
        patch(f"{_PATCH_PREFIX}.generate_pairs", return_value=(
            [{"instruction": "q", "response": "a"}] * 10, [],
        )),
        patch(f"{_PATCH_PREFIX}.save_dataset", return_value=Path("dataset.jsonl")),
        patch(f"{_PATCH_PREFIX}.unload_model"),
        patch(f"{_PATCH_PREFIX}.evaluate_gate", return_value=GateResult(
            passed=True, delta=30.0, current_average=90.0, previous_average=60.0,
        )),
        patch(f"{_PATCH_PREFIX}.cleanup_checkpoints"),
        patch(f"{_PATCH_PREFIX}.rollback_merge"),
    ):
        orch = ClosedLoopOrchestrator(config=config, state_db=db_path)
        orch._run_training = MagicMock(return_value=(adapter_path, 0.1))
        orch._run_merge = MagicMock()

        loop_id = orch.run(loop_id="test04")

    store = LoopStateStore(db_path=db_path)
    loop_state = store.get_loop("test04")
    assert loop_state is not None
    assert loop_state.stop_reason == StopReason.TARGET_REACHED
    store.close()


def test_orchestrator_manual_stop(tmp_path):
    """Verify that a stop_requested flag causes early termination."""
    config = _make_config(tmp_path, max_cycles=5)
    db_path = tmp_path / "state.db"

    baseline_result = _benchmark_result(60.0)

    with (
        patch(f"{_PATCH_PREFIX}.run_benchmarks", return_value=baseline_result),
    ):
        orch = ClosedLoopOrchestrator(config=config, state_db=db_path)

        # Pre-create the loop and request a stop so the first cycle check triggers it
        orch._state.create_loop("test05", {})
        orch._state.request_stop("test05")

        # Now patch the create_loop to be a no-op since we already created it
        with patch.object(orch._state, "create_loop", return_value=MagicMock()):
            loop_id = orch.run(loop_id="test05")

    assert loop_id == "test05"

    store = LoopStateStore(db_path=db_path)
    loop_state = store.get_loop("test05")
    assert loop_state is not None
    assert loop_state.stop_reason == StopReason.MANUAL_STOP
    store.close()
