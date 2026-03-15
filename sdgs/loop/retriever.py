"""Tally-agent-driven paper retrieval for the closed-loop system."""
from __future__ import annotations

import logging

from sdgs.scrape import search_papers

log = logging.getLogger(__name__)


def build_search_calls(
    tally_metadata: dict,
    max_papers_per_cluster: int = 10,
) -> list[dict]:
    """Convert tally agent's search_queries into search call specs.

    Args:
        tally_metadata: Output dict from the tally agent, expected to contain
            a "search_queries" list.
        max_papers_per_cluster: Max results requested per query.

    Returns:
        List of dicts, each with "query" and "max_results" keys.
    """
    queries = tally_metadata.get("search_queries", [])
    return [{"query": q, "max_results": max_papers_per_cluster} for q in queries]


def retrieve_papers(
    tally_metadata: dict,
    sources: list[str] | None = None,
    max_papers_per_cluster: int = 10,
) -> list[dict]:
    """Retrieve papers driven by the tally agent's search queries.

    Iterates over each search call spec produced by build_search_calls, calls
    search_papers for each, deduplicates results by paper_id, and logs a
    warning on any individual query failure so that remaining queries still
    execute.

    Args:
        tally_metadata: Output dict from the tally agent.
        sources: Optional list of sources to pass to search_papers
            (e.g. ["arxiv", "openalex"]).
        max_papers_per_cluster: Max papers requested per query.

    Returns:
        Deduplicated list of paper metadata dicts.
    """
    calls = build_search_calls(tally_metadata, max_papers_per_cluster=max_papers_per_cluster)

    seen_ids: set[str] = set()
    results: list[dict] = []

    for call in calls:
        query = call["query"]
        max_results = call["max_results"]
        try:
            papers = search_papers(query, max_results=max_results, sources=sources)
        except Exception as exc:
            log.warning("search_papers failed for query %r: %s", query, exc)
            continue

        for paper in papers:
            pid = paper.get("paper_id")
            if pid and pid in seen_ids:
                continue
            if pid:
                seen_ids.add(pid)
            results.append(paper)

    return results


def extract_paper_text(papers: list[dict]) -> list[dict]:
    """Download and extract full text for papers that have a pdf_url.

    Uses PyMuPDF (fitz) to extract text from each downloaded PDF. Adds a
    "full_text" field to each paper dict, capped at 50,000 characters. Skips
    papers that already have a non-empty full_text value.

    Args:
        papers: List of paper metadata dicts, potentially with pdf_url set.

    Returns:
        The same list, with "full_text" populated where extraction succeeded.
    """
    try:
        import io

        import fitz  # PyMuPDF
        import requests
    except ImportError as exc:
        log.error("extract_paper_text requires PyMuPDF (fitz) and requests: %s", exc)
        return papers

    _PDF_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/pdf,*/*;q=0.8",
    }
    _MAX_CHARS = 50_000

    for paper in papers:
        if paper.get("full_text"):
            continue

        pdf_url = paper.get("pdf_url")
        if not pdf_url:
            continue

        try:
            resp = requests.get(pdf_url, headers=_PDF_HEADERS, timeout=60, stream=True)
            resp.raise_for_status()
            raw_bytes = resp.content

            pdf_stream = io.BytesIO(raw_bytes)
            doc = fitz.open(stream=pdf_stream, filetype="pdf")
            text_parts = [page.get_text() for page in doc]
            doc.close()

            full_text = "\n".join(text_parts).strip()
            if full_text:
                paper["full_text"] = full_text[:_MAX_CHARS]
        except Exception as exc:
            log.warning(
                "PDF extraction failed for paper %r (%s): %s",
                paper.get("paper_id", "unknown"),
                pdf_url,
                exc,
            )

    return papers
