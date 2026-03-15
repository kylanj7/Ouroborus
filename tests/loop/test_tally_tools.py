"""Tests for sdgs.loop.tally_tools."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sdgs.loop.cycle_logger import CycleLogger


# ---------------------------------------------------------------------------
# test_search_semantic_scholar_returns_papers
# ---------------------------------------------------------------------------

def test_search_semantic_scholar_returns_papers():
    """search_semantic_scholar_fn returns JSON list with correct fields."""
    fake_papers = [
        {
            "paper_id": "s2:abc123",
            "title": "Deep Learning for Everything",
            "abstract": "A" * 400,
            "citation_count": 42,
            "year": 2023,
        }
    ]

    with patch("sdgs.loop.tally_tools._search_semantic_scholar", return_value=fake_papers):
        from sdgs.loop.tally_tools import search_semantic_scholar_fn
        result = search_semantic_scholar_fn("deep learning", max_results=5)

    papers = json.loads(result)
    assert isinstance(papers, list)
    assert len(papers) == 1

    p = papers[0]
    assert p["title"] == "Deep Learning for Everything"
    assert p["paper_id"] == "s2:abc123"
    assert p["citation_count"] == 42
    assert p["year"] == 2023
    # abstract should be truncated to 300 chars
    assert len(p["abstract"]) == 300


# ---------------------------------------------------------------------------
# test_query_training_history_returns_history
# ---------------------------------------------------------------------------

def test_query_training_history_returns_history(tmp_path: Path):
    """make_training_history_tool returns JSON of cycle history."""
    cycle_logger = CycleLogger(log_dir=tmp_path)
    cycle_logger.log_cycle({"cycle": 1, "score": 70.0, "gate_passed": True})

    from sdgs.loop.tally_tools import make_training_history_tool
    query_tool = make_training_history_tool(log_dir=tmp_path, history_window=5)

    result = query_tool.invoke({"query_type": "all"})
    history = json.loads(result)

    assert isinstance(history, list)
    assert len(history) == 1
    assert history[0]["cycle"] == 1
    assert history[0]["score"] == 70.0


# ---------------------------------------------------------------------------
# test_submit_analysis_valid
# ---------------------------------------------------------------------------

def test_submit_analysis_valid():
    """submit_analysis_fn accepts valid JSON and returns success message."""
    # Reset module state between tests
    import sdgs.loop.tally_tools as tt
    tt._submitted_analysis = None

    valid = {
        "clusters": [
            {
                "gap_description": "algebra",
                "root_cause": "weak algebra skills",
                "affected_questions": ["q1", "q2"],
                "priority_score": 0.8,
            }
        ],
        "search_queries": ["algebra basics"],
        "generation_guidance": "generate more algebra examples",
    }

    from sdgs.loop.tally_tools import submit_analysis_fn, get_submitted_analysis
    result = submit_analysis_fn(json.dumps(valid))

    assert "Success" in result
    stored = get_submitted_analysis()
    assert stored is not None
    assert stored["clusters"][0]["gap_description"] == "algebra"


# ---------------------------------------------------------------------------
# test_submit_analysis_invalid_missing_keys
# ---------------------------------------------------------------------------

def test_submit_analysis_invalid_missing_keys():
    """submit_analysis_fn rejects JSON missing required top-level keys."""
    import sdgs.loop.tally_tools as tt
    tt._submitted_analysis = None

    missing_search_queries = {
        "clusters": [
            {
                "gap_description": "algebra",
                "root_cause": "weak algebra",
                "affected_questions": ["q1"],
                "priority_score": 0.9,
            }
        ],
        "generation_guidance": "do more algebra",
        # "search_queries" is intentionally absent
    }

    from sdgs.loop.tally_tools import submit_analysis_fn
    result = submit_analysis_fn(json.dumps(missing_search_queries))

    assert "Error" in result


# ---------------------------------------------------------------------------
# test_submit_analysis_empty_clusters
# ---------------------------------------------------------------------------

def test_submit_analysis_empty_clusters():
    """submit_analysis_fn rejects JSON with empty clusters list."""
    import sdgs.loop.tally_tools as tt
    tt._submitted_analysis = None

    empty_clusters = {
        "clusters": [],
        "search_queries": ["some query"],
        "generation_guidance": "generate something",
    }

    from sdgs.loop.tally_tools import submit_analysis_fn
    result = submit_analysis_fn(json.dumps(empty_clusters))

    assert "Error" in result
