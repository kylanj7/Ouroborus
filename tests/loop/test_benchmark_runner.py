"""Tests for sdgs.loop.benchmark_runner."""
from __future__ import annotations

import pytest

from sdgs.loop.benchmark_runner import compute_gate_score, extract_per_question_results


# ---------------------------------------------------------------------------
# test_compute_gate_score
# ---------------------------------------------------------------------------

def test_compute_gate_score():
    """Average of four scores equals expected value."""
    scores = {
        "arc_easy": 35.0,
        "hellaswag": 60.0,
        "winogrande": 55.0,
        "piqa": 50.0,
    }
    result = compute_gate_score(scores)
    assert result == 50.0


# ---------------------------------------------------------------------------
# test_compute_gate_score_ignores_average_key
# ---------------------------------------------------------------------------

def test_compute_gate_score_ignores_average_key():
    """The 'average' key is excluded from the average calculation."""
    scores = {
        "arc_easy": 35.0,
        "hellaswag": 60.0,
        "winogrande": 55.0,
        "piqa": 50.0,
        "average": 99.0,
    }
    result = compute_gate_score(scores)
    assert result == 50.0


# ---------------------------------------------------------------------------
# test_extract_per_question_results
# ---------------------------------------------------------------------------

def test_extract_per_question_results():
    """Per-question dicts are extracted correctly from a mock lm-eval structure."""
    raw_results = {
        "samples": {
            "arc_easy": [
                {
                    "doc": {"question": "What is 2+2?"},
                    "target": "4",
                    "filtered_resps": [["4", 0.9]],
                    "acc": 1,
                },
                {
                    "doc": {"question": "What is the capital of France?"},
                    "target": "Paris",
                    "filtered_resps": [["Berlin", 0.7]],
                    "acc": 0,
                },
            ],
            "hellaswag": [
                {
                    "doc": {"input": "The sky is ..."},
                    "target": "blue",
                    "filtered_resps": [["blue", 0.95]],
                    "acc": 1,
                },
            ],
        }
    }

    results = extract_per_question_results(raw_results)

    assert len(results) == 3

    # First arc_easy sample
    r0 = results[0]
    assert r0["task"] == "arc_easy"
    assert r0["question"] == "What is 2+2?"
    assert r0["model_answer"] == "4"
    assert r0["correct_answer"] == "4"
    assert r0["passed"] is True

    # Second arc_easy sample
    r1 = results[1]
    assert r1["task"] == "arc_easy"
    assert r1["question"] == "What is the capital of France?"
    assert r1["model_answer"] == "Berlin"
    assert r1["correct_answer"] == "Paris"
    assert r1["passed"] is False

    # hellaswag sample uses "input" key
    r2 = results[2]
    assert r2["task"] == "hellaswag"
    assert r2["question"] == "The sky is ..."
    assert r2["model_answer"] == "blue"
    assert r2["correct_answer"] == "blue"
    assert r2["passed"] is True
