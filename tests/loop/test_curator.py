"""Tests for sdgs.loop.curator."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from sdgs.loop.curator import (
    check_citations,
    chunk_paper,
    save_dataset,
    split_reasoning_steps,
)


# ---------------------------------------------------------------------------
# test_chunk_paper
# ---------------------------------------------------------------------------


def test_chunk_paper():
    """Paragraph boundaries produce distinct chunks when paragraphs meet min length."""
    text = (
        "First paragraph with enough content here to exceed fifty chars.\n\n"
        "Second paragraph with enough content here to exceed fifty chars.\n\n"
        "Third paragraph with enough content here to exceed fifty chars."
    )
    chunks = chunk_paper(text)
    assert len(chunks) == 3
    assert "First paragraph" in chunks[0]
    assert "Second paragraph" in chunks[1]
    assert "Third paragraph" in chunks[2]


def test_chunk_paper_merges_short():
    """Short paragraphs below min_chunk_len are merged with the next chunk."""
    # "Hi" is 2 chars, well below default min_chunk_len=50
    text = "Hi\n\nThis is a longer paragraph that has more than fifty characters in it."
    chunks = chunk_paper(text)
    # "Hi" is too short on its own -- should be merged
    assert len(chunks) == 1
    assert "Hi" in chunks[0]
    assert "longer paragraph" in chunks[0]


def test_chunk_paper_splits_long():
    """Paragraphs longer than max_chunk_len are split."""
    # Create a paragraph that is longer than max_chunk_len=2000
    long_para = "word " * 500  # 2500 chars
    chunks = chunk_paper(long_para, max_chunk_len=200)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= 200


def test_chunk_paper_empty():
    """Empty text returns empty list."""
    assert chunk_paper("") == []


# ---------------------------------------------------------------------------
# test_split_reasoning_steps
# ---------------------------------------------------------------------------


def test_split_reasoning_steps():
    """Step N: pattern produces correctly split steps."""
    response = (
        "Step 1: Analyze the problem carefully.\n"
        "Step 2: Apply the relevant theorem.\n"
        "Step 3: Verify the conclusion holds."
    )
    steps = split_reasoning_steps(response)
    assert len(steps) == 3
    assert "Analyze the problem carefully" in steps[0]
    assert "Apply the relevant theorem" in steps[1]
    assert "Verify the conclusion holds" in steps[2]


def test_split_reasoning_steps_paragraph_fallback():
    """Falls back to paragraph splitting when no Step N: pattern is found."""
    response = (
        "First reasoning block with sufficient text.\n\n"
        "Second reasoning block with sufficient text.\n\n"
        "Third reasoning block with sufficient text."
    )
    steps = split_reasoning_steps(response)
    assert len(steps) == 3
    assert "First reasoning block" in steps[0]
    assert "Second reasoning block" in steps[1]
    assert "Third reasoning block" in steps[2]


def test_split_reasoning_steps_filters_short():
    """Steps shorter than 10 characters are filtered out."""
    response = "Step 1: A.\nStep 2: This step has enough content to survive filtering."
    steps = split_reasoning_steps(response)
    # "A." after stripping "Step 1:" prefix is too short
    assert all(len(s) >= 10 for s in steps)
    assert any("enough content" in s for s in steps)


# ---------------------------------------------------------------------------
# test_check_citations
# ---------------------------------------------------------------------------


def test_citation_check_passes():
    """Citation that matches a paper title returns passed=True."""
    response = 'According to [Paper: "Attention Is All You Need"], transformers work well.'
    paper_titles = ["Attention Is All You Need", "BERT: Pre-training of Deep Bidirectional Transformers"]
    paper_texts = ["Transformer paper text.", "BERT paper text."]
    result = check_citations(response, paper_titles, paper_texts)
    assert result["passed"] is True


def test_citation_check_fails():
    """Citation that does not match any paper title returns passed=False."""
    response = 'According to [Paper: "Nonexistent Paper Title"], something happens.'
    paper_titles = ["Attention Is All You Need", "BERT: Pre-training of Deep Bidirectional Transformers"]
    paper_texts = ["Transformer paper text.", "BERT paper text."]
    result = check_citations(response, paper_titles, paper_texts)
    assert result["passed"] is False
    assert "reason" in result
    assert len(result["reason"]) > 0


def test_citation_check_no_citations():
    """Response with no citations always passes (nothing to check)."""
    response = "This response has no inline citations at all."
    paper_titles = ["Some Paper"]
    paper_texts = ["Some paper text."]
    result = check_citations(response, paper_titles, paper_texts)
    assert result["passed"] is True


def test_citation_check_case_insensitive():
    """Citation matching is case-insensitive."""
    response = 'See [Paper: "attention is all you need"] for details.'
    paper_titles = ["Attention Is All You Need"]
    paper_texts = ["Transformer paper text."]
    result = check_citations(response, paper_titles, paper_texts)
    assert result["passed"] is True


# ---------------------------------------------------------------------------
# test_save_dataset
# ---------------------------------------------------------------------------


def test_save_dataset():
    """Saved pairs can be read back as valid JSONL."""
    pairs = [
        {"instruction": "What is 2+2?", "response": "4", "citations": []},
        {"instruction": "Explain gravity.", "response": "Objects attract.", "citations": []},
    ]
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = Path(tmpdir) / "dataset.jsonl"
        result_path = save_dataset(pairs, output_path)

        assert result_path == output_path
        assert output_path.exists()

        lines = output_path.read_text().strip().split("\n")
        assert len(lines) == 2

        first = json.loads(lines[0])
        assert first["instruction"] == "What is 2+2?"
        assert first["response"] == "4"


def test_save_dataset_with_rejects():
    """Rejects are saved to a separate file when rejects_path is given."""
    pairs = [{"instruction": "Q1", "response": "A1"}]
    rejects = [{"instruction": "Q2", "response": "A2", "reject_reason": "contradiction"}]

    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = Path(tmpdir) / "accepted.jsonl"
        rejects_path = Path(tmpdir) / "rejected.jsonl"
        save_dataset(pairs, output_path, rejects=rejects, rejects_path=rejects_path)

        assert output_path.exists()
        assert rejects_path.exists()

        reject_line = json.loads(rejects_path.read_text().strip())
        assert reject_line["instruction"] == "Q2"
        assert reject_line["reject_reason"] == "contradiction"


def test_save_dataset_returns_path():
    """save_dataset returns a Path object."""
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = Path(tmpdir) / "out.jsonl"
        result = save_dataset([{"instruction": "x", "response": "y"}], output_path)
        assert isinstance(result, Path)


# ---------------------------------------------------------------------------
# test_build_verification_feedback
# ---------------------------------------------------------------------------


def test_build_citation_feedback():
    from sdgs.loop.curator import build_verification_feedback
    results = [{"check": "citation", "passed": False, "reason": "Citations not matched: ['Nonexistent']"}]
    feedback = build_verification_feedback(results, ["Quantum Decoherence", "Bell Inequality"])
    assert "CITATION ERROR" in feedback
    assert "Quantum Decoherence" in feedback


def test_build_entailment_feedback():
    from sdgs.loop.curator import build_verification_feedback
    results = [{"check": "entailment", "passed": False, "reason": "Contradictions found"}]
    feedback = build_verification_feedback(results, [])
    assert "FACTUAL ERROR" in feedback


def test_build_combined_feedback():
    from sdgs.loop.curator import build_verification_feedback
    results = [
        {"check": "citation", "passed": False, "reason": "bad citation"},
        {"check": "chunk_tracing", "passed": False, "reason": "ungrounded step"},
    ]
    feedback = build_verification_feedback(results, ["Paper A"])
    assert "CITATION ERROR" in feedback
    assert "UNGROUNDED CONTENT" in feedback


def test_build_feedback_skips_passed():
    from sdgs.loop.curator import build_verification_feedback
    results = [
        {"check": "citation", "passed": True, "reason": "OK"},
        {"check": "entailment", "passed": False, "reason": "bad"},
    ]
    feedback = build_verification_feedback(results, [])
    assert "CITATION ERROR" not in feedback
    assert "FACTUAL ERROR" in feedback
