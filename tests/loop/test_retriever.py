"""Tests for sdgs.loop.retriever."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from sdgs.loop.retriever import build_search_calls, retrieve_papers


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

SAMPLE_TALLY_METADATA = {
    "clusters": [
        {
            "gap_description": "algebra fundamentals",
            "root_cause": "Model struggles with basic algebraic manipulation",
            "affected_questions": ["What is the derivative of x^2?"],
            "priority_score": 0.9,
        },
        {
            "gap_description": "Newton's laws of motion",
            "root_cause": "Model confuses Newton's second and third laws",
            "affected_questions": ["What is Newton's second law?"],
            "priority_score": 0.6,
        },
    ],
    "search_queries": [
        "algebra fundamentals calculus derivatives",
        "Newton laws of motion physics",
    ],
    "generation_guidance": "Focus on examples that reinforce algebraic and physics concepts.",
}


# ---------------------------------------------------------------------------
# test_build_search_calls
# ---------------------------------------------------------------------------


def test_build_search_calls_basic():
    """Each search_query produces one call spec with query and max_results."""
    calls = build_search_calls(SAMPLE_TALLY_METADATA)

    assert len(calls) == 2
    assert calls[0]["query"] == "algebra fundamentals calculus derivatives"
    assert calls[1]["query"] == "Newton laws of motion physics"
    assert calls[0]["max_results"] == 10
    assert calls[1]["max_results"] == 10


def test_build_search_calls_custom_max():
    """max_papers_per_cluster is reflected in each call's max_results."""
    calls = build_search_calls(SAMPLE_TALLY_METADATA, max_papers_per_cluster=5)

    assert all(c["max_results"] == 5 for c in calls)


def test_build_search_calls_empty_queries():
    """Empty search_queries list produces empty output."""
    metadata = {**SAMPLE_TALLY_METADATA, "search_queries": []}
    calls = build_search_calls(metadata)

    assert calls == []


def test_build_search_calls_missing_key():
    """Missing search_queries key produces empty output without raising."""
    calls = build_search_calls({})

    assert calls == []


# ---------------------------------------------------------------------------
# test_retrieve_papers_deduplicates
# ---------------------------------------------------------------------------


def _make_paper(paper_id: str, title: str) -> dict:
    return {
        "paper_id": paper_id,
        "title": title,
        "authors": ["Author A"],
        "abstract": "Some abstract text.",
        "year": 2023,
        "doi": None,
        "url": f"https://example.com/{paper_id}",
        "pdf_url": None,
        "source": "arxiv",
        "citation_count": 5,
        "full_text": None,
    }


def test_retrieve_papers_deduplicates():
    """Papers with identical paper_id returned by multiple queries are deduplicated."""
    paper_a = _make_paper("arxiv:1234.5678", "Paper on Algebra")
    paper_b = _make_paper("arxiv:9999.0001", "Paper on Newton")
    paper_dup = _make_paper("arxiv:1234.5678", "Paper on Algebra")  # duplicate of paper_a

    # First query returns paper_a + paper_b, second query returns dup + paper_b
    side_effects = [
        [paper_a, paper_b],
        [paper_dup, paper_b],
    ]

    with patch("sdgs.loop.retriever.search_papers", side_effect=side_effects) as mock_sp:
        results = retrieve_papers(SAMPLE_TALLY_METADATA)

    assert mock_sp.call_count == 2
    result_ids = [p["paper_id"] for p in results]
    # Each id must appear exactly once
    assert result_ids.count("arxiv:1234.5678") == 1
    assert result_ids.count("arxiv:9999.0001") == 1
    assert len(results) == 2


def test_retrieve_papers_passes_sources():
    """sources argument is forwarded to each search_papers call."""
    paper = _make_paper("arxiv:0001.0001", "Test Paper")

    with patch("sdgs.loop.retriever.search_papers", return_value=[paper]) as mock_sp:
        retrieve_papers(SAMPLE_TALLY_METADATA, sources=["arxiv"])

    for call in mock_sp.call_args_list:
        _, kwargs = call
        assert kwargs.get("sources") == ["arxiv"]


# ---------------------------------------------------------------------------
# test_retrieve_papers_handles_failure
# ---------------------------------------------------------------------------


def test_retrieve_papers_handles_failure():
    """A search_papers exception is caught; other queries still execute."""
    paper_b = _make_paper("arxiv:9999.0001", "Paper on Newton")

    side_effects = [
        RuntimeError("API unavailable"),
        [paper_b],
    ]

    with patch("sdgs.loop.retriever.search_papers", side_effect=side_effects):
        # Should not raise
        results = retrieve_papers(SAMPLE_TALLY_METADATA)

    # The second query's paper should still be returned
    assert len(results) == 1
    assert results[0]["paper_id"] == "arxiv:9999.0001"


def test_retrieve_papers_all_queries_fail():
    """All queries failing returns an empty list without raising."""
    with patch("sdgs.loop.retriever.search_papers", side_effect=RuntimeError("down")):
        results = retrieve_papers(SAMPLE_TALLY_METADATA)

    assert results == []
