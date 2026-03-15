"""Tests for sdgs.loop.tally_agent."""
from __future__ import annotations

import pytest

from sdgs.loop.tally_agent import (
    build_tally_prompt,
    fallback_analysis,
    parse_tally_output,
)


SAMPLE_FAILED = [
    {
        "task": "math",
        "question": "What is the derivative of x^2?",
        "model_answer": "x",
        "correct_answer": "2x",
        "passed": False,
    },
    {
        "task": "math",
        "question": "Solve for x: 2x + 4 = 10",
        "model_answer": "x = 2",
        "correct_answer": "x = 3",
        "passed": False,
    },
    {
        "task": "physics",
        "question": "What is Newton's second law?",
        "model_answer": "F = mv",
        "correct_answer": "F = ma",
        "passed": False,
    },
]


# ---------------------------------------------------------------------------
# test_build_tally_prompt
# ---------------------------------------------------------------------------


def test_build_tally_prompt():
    """Prompt contains question text and instructs to cluster."""
    prompt = build_tally_prompt(SAMPLE_FAILED, history=[])

    assert "derivative of x^2" in prompt
    assert "cluster" in prompt.lower()


def test_build_tally_prompt_with_history():
    """Prompt includes history context when provided."""
    history = [{"cycle": 1, "score": 60.0}]
    prompt = build_tally_prompt(SAMPLE_FAILED, history=history)

    assert "derivative of x^2" in prompt
    assert "cluster" in prompt.lower()


def test_build_tally_prompt_max_questions():
    """max_questions truncates the failed list."""
    prompt = build_tally_prompt(SAMPLE_FAILED, history=[], max_questions=1)

    # Only the first question should appear
    assert "derivative of x^2" in prompt
    # The third question should NOT appear because of the limit
    assert "Newton" not in prompt


# ---------------------------------------------------------------------------
# test_parse_tally_output_valid
# ---------------------------------------------------------------------------


def test_parse_tally_output_valid():
    """Parse a raw JSON string into a dict with required keys."""
    raw = (
        '{"clusters": [{"gap_description": "algebra", "root_cause": "weak algebra",'
        ' "affected_questions": ["q1"], "priority_score": 0.9}],'
        ' "search_queries": ["algebra basics"], "generation_guidance": "focus on algebra"}'
    )
    result = parse_tally_output(raw)

    assert "clusters" in result
    assert "search_queries" in result
    assert "generation_guidance" in result
    assert len(result["clusters"]) == 1
    assert result["clusters"][0]["gap_description"] == "algebra"


def test_parse_tally_output_with_markdown():
    """Parse JSON wrapped in ```json ... ``` code fences."""
    raw = (
        "Here is the analysis:\n"
        "```json\n"
        '{"clusters": [], "search_queries": ["test query"], "generation_guidance": "do more"}\n'
        "```\n"
    )
    result = parse_tally_output(raw)

    assert result["search_queries"] == ["test query"]
    assert result["generation_guidance"] == "do more"
    assert result["clusters"] == []


def test_parse_tally_output_no_json_raises():
    """Raise ValueError when no JSON is found in the raw output."""
    with pytest.raises(ValueError, match="No JSON"):
        parse_tally_output("This is just plain text with no JSON at all.")


def test_parse_tally_output_missing_keys_raises():
    """Raise ValueError when required keys are absent from the parsed JSON."""
    raw = '{"clusters": []}'
    with pytest.raises(ValueError):
        parse_tally_output(raw)


# ---------------------------------------------------------------------------
# test_fallback_analysis
# ---------------------------------------------------------------------------


def test_fallback_analysis():
    """Fallback produces clusters and search_queries from failed questions."""
    result = fallback_analysis(SAMPLE_FAILED)

    assert "clusters" in result
    assert "search_queries" in result
    assert "generation_guidance" in result
    assert isinstance(result["clusters"], list)
    assert isinstance(result["search_queries"], list)
    assert len(result["clusters"]) > 0
    assert len(result["search_queries"]) > 0


def test_fallback_analysis_groups_by_task():
    """Fallback creates one cluster per unique task."""
    result = fallback_analysis(SAMPLE_FAILED)

    task_names = {c["gap_description"] for c in result["clusters"]}
    assert "math" in task_names
    assert "physics" in task_names


def test_fallback_analysis_empty_input():
    """Fallback handles empty failed_questions list without error."""
    result = fallback_analysis([])

    assert result["clusters"] == []
    assert result["search_queries"] == []


# ---------------------------------------------------------------------------
# test_run_tally
# ---------------------------------------------------------------------------


def test_run_tally_falls_back_on_agent_failure(tmp_path):
    from sdgs.loop.tally_agent import run_tally
    from unittest.mock import patch
    failed = [
        {"task": "gpqa", "question": "What is decoherence?",
         "model_answer": "A", "correct_answer": "C", "passed": False},
    ]
    with patch("sdgs.loop.tally_agent.create_react_agent", side_effect=Exception("no ollama")):
        result = run_tally(failed, [], log_dir=str(tmp_path))
        assert "clusters" in result
        assert "search_queries" in result
        assert len(result["clusters"]) > 0
