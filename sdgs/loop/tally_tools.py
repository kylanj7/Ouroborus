"""LangChain tools for the tally agent's ReAct investigation."""
from __future__ import annotations

import json
import logging

from langchain_core.tools import tool

from sdgs.scrape import _rate_limit
from sdgs.scrape import _search_semantic_scholar as _scrape_search_semantic_scholar

log = logging.getLogger(__name__)

# Module-level storage for submitted analysis
_submitted_analysis: dict | None = None


# ---------------------------------------------------------------------------
# Semantic Scholar search
# ---------------------------------------------------------------------------

def _search_semantic_scholar(query: str, max_results: int = 5) -> list[dict]:
    """Internal: call scrape._search_semantic_scholar with rate limiting."""
    _rate_limit("semantic_scholar", 1.0)
    return _scrape_search_semantic_scholar(query, max_results)


def search_semantic_scholar_fn(query: str, max_results: int = 5) -> str:
    """Search Semantic Scholar and return JSON list of paper summaries.

    Each paper has: title, abstract (truncated to 300 chars),
    citation_count, year, paper_id.

    Returns a JSON string on success, or a JSON error object on failure.
    """
    try:
        papers = _search_semantic_scholar(query, max_results=max_results)
        results = []
        for p in papers:
            abstract = (p.get("abstract") or "")[:300]
            results.append({
                "title": p.get("title", ""),
                "abstract": abstract,
                "citation_count": p.get("citation_count", 0),
                "year": p.get("year"),
                "paper_id": p.get("paper_id", ""),
            })
        return json.dumps(results)
    except Exception as exc:
        log.warning("search_semantic_scholar_fn error: %s", exc)
        return json.dumps({"error": str(exc)})


@tool
def search_semantic_scholar(query: str, max_results: int = 5) -> str:
    """Search Semantic Scholar for relevant research papers.

    Use this tool when you need to find academic papers that could provide
    training material to address a specific knowledge gap identified in the
    benchmark failures. Pass a focused query string describing the topic.

    Returns a JSON list of papers with fields:
    title, abstract (truncated), citation_count, year, paper_id.
    """
    return search_semantic_scholar_fn(query, max_results=max_results)


# ---------------------------------------------------------------------------
# Training history tool factory
# ---------------------------------------------------------------------------

def make_training_history_tool(log_dir, history_window: int = 5):
    """Create a LangChain tool for querying the training cycle history.

    Args:
        log_dir: Directory where the CycleLogger writes its JSONL log.
        history_window: Number of most recent cycles to return.

    Returns:
        A LangChain @tool callable.
    """
    from sdgs.loop.cycle_logger import CycleLogger

    cycle_logger = CycleLogger(log_dir=log_dir)

    @tool
    def query_training_history(query_type: str = "all") -> str:
        """Query the training cycle history.

        Use this tool to understand what has been tried in previous training
        cycles and what gaps have already been addressed.

        Args:
            query_type: One of "all", "gaps", or "datasets".
                - "all": return the full cycle records.
                - "gaps": extract cycle, gate_passed, top_gaps from
                  each cycle's tally_summary.
                - "datasets": extract cycle, dataset_path, dataset_size
                  from each cycle record.

        Returns a JSON list of cycle records (or extracted fields).
        """
        history = cycle_logger.get_cycle_history(last_n=history_window)

        if query_type == "gaps":
            extracted = []
            for entry in history:
                tally = entry.get("tally_summary") or {}
                extracted.append({
                    "cycle": entry.get("cycle"),
                    "gate_passed": entry.get("gate_passed"),
                    "top_gaps": tally.get("top_gaps"),
                })
            return json.dumps(extracted)

        if query_type == "datasets":
            extracted = []
            for entry in history:
                extracted.append({
                    "cycle": entry.get("cycle"),
                    "dataset_path": entry.get("dataset_path"),
                    "dataset_size": entry.get("dataset_size"),
                })
            return json.dumps(extracted)

        # Default: "all"
        return json.dumps(history)

    return query_training_history


# ---------------------------------------------------------------------------
# Submit analysis
# ---------------------------------------------------------------------------

def submit_analysis_fn(analysis_json: str) -> str:
    """Validate and store a tally analysis JSON string.

    Required top-level keys: clusters, search_queries, generation_guidance.
    clusters must not be empty.
    Each cluster must have: gap_description, root_cause,
        affected_questions, priority_score.
    search_queries must not be empty.

    Returns:
        "Success: Analysis submitted." on success.
        "Error: <message>" on validation failure or parse error.
    """
    global _submitted_analysis

    try:
        data = json.loads(analysis_json)
    except json.JSONDecodeError as exc:
        return f"Error: Invalid JSON -- {exc}"

    required_keys = {"clusters", "search_queries", "generation_guidance"}
    missing = required_keys - set(data.keys())
    if missing:
        return f"Error: Missing required keys: {', '.join(sorted(missing))}"

    clusters = data["clusters"]
    if not isinstance(clusters, list) or len(clusters) == 0:
        return "Error: clusters must be a non-empty list"

    required_cluster_keys = {"gap_description", "root_cause", "affected_questions", "priority_score"}
    for i, cluster in enumerate(clusters):
        missing_c = required_cluster_keys - set(cluster.keys())
        if missing_c:
            return f"Error: cluster[{i}] missing keys: {', '.join(sorted(missing_c))}"

    search_queries = data["search_queries"]
    if not isinstance(search_queries, list) or len(search_queries) == 0:
        return "Error: search_queries must be a non-empty list"

    _submitted_analysis = data
    return "Success: Analysis submitted."


@tool
def submit_analysis(analysis_json: str) -> str:
    """Submit the completed tally analysis as a JSON string.

    Use this tool once you have finished your ReAct investigation and are
    ready to submit your structured findings. The JSON must contain:
    - clusters: non-empty list of gap objects (each with gap_description,
      root_cause, affected_questions, priority_score)
    - search_queries: non-empty list of query strings
    - generation_guidance: string describing what training examples to create

    Returns "Success: Analysis submitted." or an "Error: ..." message.
    """
    return submit_analysis_fn(analysis_json)


# ---------------------------------------------------------------------------
# Retrieve stored analysis
# ---------------------------------------------------------------------------

def get_submitted_analysis() -> dict | None:
    """Retrieve and clear the stored submitted analysis.

    Returns:
        The previously submitted analysis dict, or None if none was submitted.
        Clears the stored value after retrieval.
    """
    global _submitted_analysis
    result = _submitted_analysis
    _submitted_analysis = None
    return result
