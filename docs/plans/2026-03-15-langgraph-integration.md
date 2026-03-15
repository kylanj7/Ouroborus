# LangGraph Tally Agent + Curator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the tally agent into a LangGraph ReAct agent with tools (Semantic Scholar search, training history lookup) and add a self-correction loop to the curator that feeds verification failures back to the generator.

**Architecture:** The tally agent becomes a LangGraph ReAct agent that decides its own investigation path using 3 tools before submitting structured analysis. The curator wraps its per-pair verification in a LangGraph graph that retries failed pairs with specific feedback up to 3 times. The outer bulk generation loop stays as plain Python. Verification models (DeBERTa, MiniLM) are loaded once and shared.

**Tech Stack:** LangGraph (`langgraph`, `langgraph-prebuilt`), LangChain + langchain-ollama, transformers (NLI), sentence-transformers (embeddings)

**Spec:** `docs/specs/2026-03-15-langgraph-tally-curator-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `sdgs/loop/tally_tools.py` | LangChain tool implementations: `search_semantic_scholar`, `make_training_history_tool`, `submit_analysis` |
| `tests/loop/test_tally_tools.py` | Tests for tally tools |

### Modified Files
| File | Change |
|------|--------|
| `pyproject.toml` | Add `langgraph>=0.2` to `[loop]` deps |
| `sdgs/loop/config_v2.py` | Add `max_tool_calls`, `timeout_seconds` to TallyConfig; add `max_retries_per_pair` to CurationConfig |
| `sdgs/loop/tally_agent.py` | Rewrite `run_tally()` to use LangGraph ReAct agent with tools |
| `sdgs/loop/curator.py` | Add self-correction loop with feedback construction; load verification models once; run all 3 checks per attempt |
| `sdgs/loop/orchestrator_v2.py` | Pass new config values to `run_tally()` |
| `configs/closed_loop.yaml` | Add new config fields, enable all 4 paper sources |
| `configs/closed_loop_test.yaml` | Add new config fields with test values |
| `tests/loop/test_tally_agent.py` | Update tests for LangGraph-based agent |
| `tests/loop/test_curator.py` | Add tests for feedback construction |

---

## Task 1: Add langgraph dependency

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: Add langgraph to loop deps**

In `pyproject.toml`, change the `loop` section to:

```toml
loop = [
    "langchain>=0.3",
    "langchain-ollama>=0.3",
    "langgraph>=0.2",
    "lm-eval>=0.4",
    "sentence-transformers>=3.0",
]
```

- [ ] **Step 2: Install and verify**

Run: `pip install -e ".[loop]" && python -c "from langgraph.prebuilt import create_react_agent; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml
git commit -m "feat: add langgraph dependency for ReAct tally agent"
```

---

## Task 2: Update config dataclasses

**Files:**
- Modify: `sdgs/loop/config_v2.py`
- Modify: `tests/loop/test_config_v2.py`

- [ ] **Step 1: Write failing test**

Add to `tests/loop/test_config_v2.py`:

```python
def test_tally_config_new_fields():
    from sdgs.loop.config_v2 import ClosedLoopConfig
    config = ClosedLoopConfig()
    assert config.tally.max_tool_calls == 20
    assert config.tally.timeout_seconds == 600

def test_curation_config_new_fields():
    from sdgs.loop.config_v2 import ClosedLoopConfig
    config = ClosedLoopConfig()
    assert config.curation.max_retries_per_pair == 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_config_v2.py::test_tally_config_new_fields -v`
Expected: FAIL (AttributeError)

- [ ] **Step 3: Add fields to TallyConfig and CurationConfig**

In `sdgs/loop/config_v2.py`, add to `TallyConfig`:
```python
    max_tool_calls: int = 20
    timeout_seconds: int = 600
```

Add to `CurationConfig`:
```python
    max_retries_per_pair: int = 3
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_config_v2.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add sdgs/loop/config_v2.py tests/loop/test_config_v2.py
git commit -m "feat: add LangGraph config fields (max_tool_calls, timeout, retries_per_pair)"
```

---

## Task 3: Tally tools

**Files:**
- Create: `sdgs/loop/tally_tools.py`
- Create: `tests/loop/test_tally_tools.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/loop/test_tally_tools.py
import json
import pytest
from unittest.mock import patch, MagicMock

def test_search_semantic_scholar_returns_papers():
    from sdgs.loop.tally_tools import search_semantic_scholar_fn
    mock_papers = [
        {"paper_id": "s2:123", "title": "Quantum Decoherence", "abstract": "...", "citation_count": 50, "year": 2023}
    ]
    with patch("sdgs.loop.tally_tools._search_semantic_scholar", return_value=mock_papers):
        result = search_semantic_scholar_fn("quantum decoherence", 5)
        parsed = json.loads(result)
        assert len(parsed) == 1
        assert parsed[0]["title"] == "Quantum Decoherence"

def test_query_training_history_returns_history():
    from sdgs.loop.tally_tools import make_training_history_tool
    from sdgs.loop.cycle_logger import CycleLogger
    import tempfile, os
    with tempfile.TemporaryDirectory() as tmp:
        logger = CycleLogger(log_dir=tmp)
        logger.log_cycle({"cycle": 1, "benchmarks": {"average": 45.0}, "gate_passed": True,
                          "tally_summary": {"top_gaps": ["decoherence"]}})
        tool = make_training_history_tool(tmp, history_window=5)
        result = tool.invoke({"query_type": "all"})
        parsed = json.loads(result)
        assert len(parsed) == 1
        assert parsed[0]["cycle"] == 1

def test_submit_analysis_valid():
    from sdgs.loop.tally_tools import submit_analysis_fn
    valid = json.dumps({
        "clusters": [{"gap_description": "test", "root_cause": "test",
                       "affected_questions": [0], "priority_score": 0.8}],
        "search_queries": ["test query"],
        "generation_guidance": "test guidance"
    })
    result = submit_analysis_fn(valid)
    assert "success" in result.lower()

def test_submit_analysis_invalid():
    from sdgs.loop.tally_tools import submit_analysis_fn
    result = submit_analysis_fn('{"clusters": []}')
    assert "error" in result.lower() or "missing" in result.lower()
```

- [ ] **Step 2: Run tests to verify fail**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_tally_tools.py -v`
Expected: FAIL (ImportError)

- [ ] **Step 3: Implement tally_tools.py**

```python
# sdgs/loop/tally_tools.py
"""LangChain tools for the tally agent."""
from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.tools import tool

from sdgs.loop.cycle_logger import CycleLogger

log = logging.getLogger(__name__)


def _search_semantic_scholar(query: str, max_results: int = 5) -> list[dict]:
    """Internal: call Semantic Scholar API via existing scrape infrastructure."""
    from sdgs.scrape import _search_semantic_scholar as _ss_search, _rate_limit
    _rate_limit("semantic_scholar", 1.1)
    return _ss_search(query, max_results=max_results)


def search_semantic_scholar_fn(query: str, max_results: int = 5) -> str:
    """Search Semantic Scholar for papers. Returns JSON array of papers."""
    try:
        papers = _search_semantic_scholar(query, max_results)
        results = []
        for p in papers:
            results.append({
                "title": p.get("title", ""),
                "abstract": (p.get("abstract") or "")[:300],
                "citation_count": p.get("citation_count", 0),
                "year": p.get("year"),
                "paper_id": p.get("paper_id", ""),
            })
        return json.dumps(results)
    except Exception as e:
        return json.dumps({"error": str(e)})


@tool
def search_semantic_scholar(query: str, max_results: int = 5) -> str:
    """Search Semantic Scholar for papers on a topic.

    Use this to verify that papers exist on a suspected knowledge gap
    before committing to a search query. Check paper volume -- if only
    2 papers exist, consider broadening the topic.

    Args:
        query: Search query (e.g., "quantum decoherence T1 T2 relaxation")
        max_results: Maximum papers to return (default 5)

    Returns:
        JSON string with list of papers: [{title, abstract, citation_count, year, paper_id}]
    """
    return search_semantic_scholar_fn(query, max_results)


def make_training_history_tool(log_dir: str, history_window: int = 5):
    """Factory: creates a training history tool with bound log path."""
    logger = CycleLogger(log_dir=log_dir)

    @tool
    def query_training_history(query_type: str = "all") -> str:
        """Look up what the model was already trained on in previous cycles.

        Use this to avoid regenerating knowledge the model was already taught,
        and to understand what training approaches worked vs failed.

        Args:
            query_type: One of:
                - "all": Full cycle history (gaps targeted, datasets, outcomes)
                - "gaps": List of all knowledge gaps targeted and outcomes
                - "datasets": Paths and sizes of curated datasets

        Returns:
            JSON string with training history.
        """
        history = logger.get_cycle_history(last_n=history_window)

        if query_type == "gaps":
            gaps = []
            for entry in history:
                summary = entry.get("tally_summary", {})
                gaps.append({
                    "cycle": entry.get("cycle"),
                    "gate_passed": entry.get("gate_passed"),
                    "top_gaps": summary.get("top_gaps", []),
                })
            return json.dumps(gaps)

        if query_type == "datasets":
            datasets = []
            for entry in history:
                datasets.append({
                    "cycle": entry.get("cycle"),
                    "dataset_path": entry.get("dataset_path"),
                    "dataset_size": entry.get("dataset_size"),
                })
            return json.dumps(datasets)

        return json.dumps(history)

    return query_training_history


_submitted_analysis: dict[str, Any] | None = None


def submit_analysis_fn(analysis_json: str) -> str:
    """Validate and store the submitted analysis."""
    global _submitted_analysis
    try:
        data = json.loads(analysis_json)
    except json.JSONDecodeError as e:
        return f"Error: Invalid JSON -- {e}"

    required = {"clusters", "search_queries", "generation_guidance"}
    missing = required - set(data.keys())
    if missing:
        return f"Error: Missing required keys: {', '.join(sorted(missing))}"

    if not data["clusters"]:
        return "Error: clusters must not be empty"

    for i, cluster in enumerate(data["clusters"]):
        cluster_required = {"gap_description", "root_cause", "affected_questions", "priority_score"}
        cluster_missing = cluster_required - set(cluster.keys())
        if cluster_missing:
            return f"Error: Cluster {i} missing keys: {', '.join(sorted(cluster_missing))}"

    if not data["search_queries"]:
        return "Error: search_queries must not be empty"

    _submitted_analysis = data
    return "Success: Analysis submitted."


@tool
def submit_analysis(analysis_json: str) -> str:
    """Submit the final failure analysis. This ends your investigation.

    You MUST call this tool when you have completed your analysis.
    The JSON must contain: clusters (with gap_description, root_cause,
    affected_questions, priority_score), search_queries, and generation_guidance.

    Args:
        analysis_json: JSON string with the analysis.

    Returns:
        "Success: Analysis submitted." or error message describing what to fix.
    """
    return submit_analysis_fn(analysis_json)


def get_submitted_analysis() -> dict[str, Any] | None:
    """Retrieve the last submitted analysis (used by run_tally)."""
    global _submitted_analysis
    result = _submitted_analysis
    _submitted_analysis = None
    return result
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_tally_tools.py -v`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add sdgs/loop/tally_tools.py tests/loop/test_tally_tools.py
git commit -m "feat: add tally agent tools (semantic scholar, training history, submit)"
```

---

## Task 4: Rewrite tally agent with LangGraph

**Files:**
- Modify: `sdgs/loop/tally_agent.py`
- Modify: `tests/loop/test_tally_agent.py`

- [ ] **Step 1: Update tests**

Replace the `run_tally`-related tests (keep `build_tally_prompt`, `parse_tally_output`, `fallback_analysis` tests unchanged). Add:

```python
def test_run_tally_uses_langgraph_and_falls_back(tmp_path):
    """When the LangGraph agent fails, run_tally falls back to fallback_analysis."""
    from sdgs.loop.tally_agent import run_tally
    from unittest.mock import patch, MagicMock

    failed = [
        {"task": "gpqa", "question": "What is decoherence?",
         "model_answer": "A", "correct_answer": "C", "passed": False},
    ]
    # Mock create_react_agent to raise so we hit fallback
    with patch("sdgs.loop.tally_agent.create_react_agent", side_effect=Exception("no ollama")):
        result = run_tally(failed, [], log_dir=str(tmp_path))
        assert "clusters" in result
        assert "search_queries" in result
        assert len(result["clusters"]) > 0  # fallback produces clusters
```

- [ ] **Step 2: Rewrite run_tally in tally_agent.py**

Keep `build_tally_prompt`, `parse_tally_output`, `fallback_analysis` unchanged. Rewrite `run_tally`:

```python
def run_tally(
    failed_questions: list[dict],
    history: list[dict],
    model: str = "gpt-oss:120b",
    provider: str = "ollama",
    max_retries: int = 3,
    max_tool_calls: int = 20,
    timeout_seconds: int = 600,
    log_dir: str = "logs/loop/",
    history_window: int = 5,
) -> dict:
    """Run the LangGraph ReAct tally agent to diagnose benchmark failures.

    The agent uses tools to investigate failures before submitting analysis.
    Falls back to fallback_analysis() if the agent fails.
    """
    import signal
    from langchain_ollama import ChatOllama
    from langgraph.prebuilt import create_react_agent
    from sdgs.loop.tally_tools import (
        search_semantic_scholar,
        make_training_history_tool,
        submit_analysis,
        get_submitted_analysis,
    )

    prompt_text = build_tally_prompt(failed_questions, history)

    try:
        llm = ChatOllama(model=model, temperature=0.1)
        tools = [
            search_semantic_scholar,
            make_training_history_tool(log_dir, history_window),
            submit_analysis,
        ]

        agent = create_react_agent(model=llm, tools=tools)

        # Timeout via signal (Unix only)
        def _timeout_handler(signum, frame):
            raise TimeoutError("Tally agent timed out")

        old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(timeout_seconds)

        try:
            system_msg = TALLY_SYSTEM_PROMPT + "\n\nIMPORTANT: You MUST call the submit_analysis tool when done."
            result = agent.invoke(
                {"messages": [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": prompt_text},
                ]},
                config={"recursion_limit": max_tool_calls * 2},
            )
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)

        # Check if submit_analysis was called
        submitted = get_submitted_analysis()
        if submitted:
            log.info("Tally agent submitted analysis with %d clusters", len(submitted.get("clusters", [])))
            return submitted

        # Agent finished without submitting -- try to parse from last message
        messages = result.get("messages", [])
        if messages:
            last_content = messages[-1].content if hasattr(messages[-1], "content") else str(messages[-1])
            try:
                return parse_tally_output(last_content)
            except ValueError:
                pass

        log.warning("Tally agent completed without submitting analysis. Using fallback.")
        return fallback_analysis(failed_questions)

    except Exception as e:
        log.warning("Tally agent failed: %s. Using fallback.", e)
        return fallback_analysis(failed_questions)
```

- [ ] **Step 3: Run all tally tests**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_tally_agent.py -v`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add sdgs/loop/tally_agent.py tests/loop/test_tally_agent.py
git commit -m "feat: rewrite tally agent as LangGraph ReAct agent with tools"
```

---

## Task 5: Curator self-correction loop

**Files:**
- Modify: `sdgs/loop/curator.py`
- Modify: `tests/loop/test_curator.py`

- [ ] **Step 1: Write failing tests for feedback construction**

Add to `tests/loop/test_curator.py`:

```python
def test_build_citation_feedback():
    from sdgs.loop.curator import build_verification_feedback
    results = [
        {"check": "citation", "passed": False,
         "reason": "Citations not matched: ['Nonexistent Paper']"}
    ]
    paper_titles = ["Quantum Decoherence", "Bell Inequality"]
    feedback = build_verification_feedback(results, paper_titles)
    assert "CITATION ERROR" in feedback
    assert "Quantum Decoherence" in feedback or "available papers" in feedback.lower()

def test_build_entailment_feedback():
    from sdgs.loop.curator import build_verification_feedback
    results = [
        {"check": "entailment", "passed": False,
         "reason": "Contradictions found in steps: ['T1 is always longer']"}
    ]
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
```

- [ ] **Step 2: Run tests to verify fail**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_curator.py::test_build_citation_feedback -v`
Expected: FAIL (ImportError)

- [ ] **Step 3: Add `build_verification_feedback` function**

Add to `sdgs/loop/curator.py`:

```python
def build_verification_feedback(
    check_results: list[dict],
    paper_titles: list[str],
) -> str:
    """Build specific feedback from verification failures.

    Each check_result has: check (str), passed (bool), reason (str).
    Returns a combined feedback string for regeneration.
    """
    feedback_parts = []

    for result in check_results:
        if result["passed"]:
            continue

        check = result["check"]
        reason = result["reason"]

        if check == "citation":
            available = ", ".join(f'"{t}"' for t in paper_titles[:10])
            feedback_parts.append(
                f"CITATION ERROR: {reason}\n"
                f"Available papers: {available}\n"
                f"Use exact titles from the list above."
            )
        elif check == "entailment":
            feedback_parts.append(
                f"FACTUAL ERROR: {reason}\n"
                f"Correct the claims to match the source paper content."
            )
        elif check == "chunk_tracing":
            feedback_parts.append(
                f"UNGROUNDED CONTENT: {reason}\n"
                f"Remove or replace steps that are not grounded in the source paper."
            )

    return "\n\n".join(feedback_parts)
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_curator.py -v`
Expected: ALL PASS

- [ ] **Step 5: Modify `generate_pairs` to use self-correction loop**

Key changes to `generate_pairs()` in `curator.py`:

1. Load DeBERTa and MiniLM ONCE at the start (not per-pair)
2. Run ALL 3 verification checks per pair (no short-circuit)
3. On failure: build feedback, append to prompt, retry up to `max_retries_per_pair` times
4. Collect check results as `[{"check": "citation", "passed": bool, "reason": str}, ...]`

The self-correction is implemented as a simple retry loop (not a LangGraph graph) since it's just prompt -> verify -> feedback -> retry. LangGraph overhead isn't needed for this linear sequence.

```python
# Inside generate_pairs, replace the per-pair verification block:
max_retries = (verification_config or {}).get("max_retries_per_pair", 3)

for pair in batch:
    # ... validate pair has instruction/response ...

    accepted_pair = None
    current_pair = pair
    for attempt in range(max_retries):
        check_results = []

        # Run ALL 3 checks
        citation_result = check_citations(current_pair["response"], paper_titles, paper_texts)
        check_results.append({"check": "citation", **citation_result})

        if use_entailment:
            steps = split_reasoning_steps(current_pair["response"])
            ent_result = check_entailment(steps, paper_chunks_cached,
                                           nli_pipeline=nli_pipeline_cached,
                                           min_entailment_ratio=entailment_threshold)
            check_results.append({"check": "entailment", **ent_result})

        if use_chunk_tracing and embedding_model and chunk_embeddings:
            steps = split_reasoning_steps(current_pair["response"])
            trace_result = check_chunk_tracing(steps, chunk_embeddings, all_chunks,
                                                embedding_model, threshold=tracing_threshold)
            check_results.append({"check": "chunk_tracing", **trace_result})

        failures = [r for r in check_results if not r["passed"]]
        if not failures:
            accepted_pair = current_pair
            break

        if attempt < max_retries - 1:
            # Build feedback and regenerate
            feedback = build_verification_feedback(failures, paper_titles)
            regen_prompt = f"""{original_prompt}

PREVIOUS ATTEMPT (rejected):
{json.dumps(current_pair)}

ERRORS FOUND:
{feedback}

Generate a corrected version. Fix ALL errors. Respond with JSON:
{{"instruction": "...", "response": "..."}}"""
            try:
                regen_response = llm.invoke([HumanMessage(content=regen_prompt)])
                raw = regen_response.content if hasattr(regen_response, "content") else str(regen_response)
                # parse JSON from response...
                current_pair = parsed_pair
            except Exception:
                break  # Can't regenerate, discard

    if accepted_pair:
        accepted.append(accepted_pair)
    else:
        current_pair["reject_reasons"] = [r["reason"] for r in failures]
        rejected.append(current_pair)
```

Also modify `check_entailment` to accept a pre-loaded pipeline:
```python
def check_entailment(steps, paper_chunks, model_name=..., min_entailment_ratio=..., nli_pipeline=None):
    if nli_pipeline is None:
        from transformers import pipeline
        nli_pipeline = pipeline("zero-shot-classification", model=model_name)
    # ... use nli_pipeline instead of creating new one ...
```

- [ ] **Step 6: Run all curator tests**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_curator.py -v`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add sdgs/loop/curator.py tests/loop/test_curator.py
git commit -m "feat: add self-correction loop with feedback to curator"
```

---

## Task 6: Update orchestrator to pass new config values

**Files:**
- Modify: `sdgs/loop/orchestrator_v2.py`

- [ ] **Step 1: Update the run_tally call**

Change the `run_tally` call (around line 160) to pass the new config fields:

```python
tally_metadata = run_tally(
    failed_questions,
    history,
    model=self._config.tally.model,
    max_retries=self._config.tally.max_retries,
    max_tool_calls=self._config.tally.max_tool_calls,
    timeout_seconds=self._config.tally.timeout_seconds,
    log_dir=self._config.logging.log_dir,
    history_window=self._config.tally.history_window,
)
```

- [ ] **Step 2: Run orchestrator tests**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/test_orchestrator_v2.py -v`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add sdgs/loop/orchestrator_v2.py
git commit -m "feat: pass LangGraph config values to tally agent"
```

---

## Task 7: Update config YAML files

**Files:**
- Modify: `configs/closed_loop.yaml`
- Modify: `configs/closed_loop_test.yaml`

- [ ] **Step 1: Update production config**

Add to `tally:` section:
```yaml
  max_tool_calls: 20
  timeout_seconds: 600
```

Add to `curation:` section:
```yaml
  max_retries_per_pair: 3
```

Change `retrieval.sources` to:
```yaml
  sources:
    - semantic_scholar
    - arxiv
    - openalex
    - core
```

- [ ] **Step 2: Update test config**

Add to `tally:` section:
```yaml
  max_tool_calls: 5
  timeout_seconds: 60
```

Add to `curation:` section:
```yaml
  max_retries_per_pair: 1
```

- [ ] **Step 3: Commit**

```bash
git add configs/closed_loop.yaml configs/closed_loop_test.yaml
git commit -m "feat: update configs with LangGraph settings and all paper sources"
```

---

## Task 8: Full test suite verification

- [ ] **Step 1: Run all loop tests**

Run: `cd /home/kylan/Coding/Ouroborus && python -m pytest tests/loop/ -v`
Expected: ALL PASS

- [ ] **Step 2: Verify LangGraph import works**

Run: `python -c "from sdgs.loop.tally_agent import run_tally; from sdgs.loop.tally_tools import search_semantic_scholar; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Final commit if any unstaged changes**

```bash
git status
# If clean: done
# If changes: git add ... && git commit -m "fix: address test failures"
```

---

## Summary

| Task | Component | Files |
|------|-----------|-------|
| 1 | Add langgraph dep | `pyproject.toml` |
| 2 | Config fields | `config_v2.py`, tests |
| 3 | Tally tools | `tally_tools.py` (new), tests |
| 4 | Tally agent rewrite | `tally_agent.py`, tests |
| 5 | Curator self-correction | `curator.py`, tests |
| 6 | Orchestrator update | `orchestrator_v2.py` |
| 7 | Config YAML files | `closed_loop.yaml`, `closed_loop_test.yaml` |
| 8 | Full verification | All tests |

**Execution order:** Strict sequential (each task depends on the previous).
