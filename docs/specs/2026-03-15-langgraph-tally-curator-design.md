# LangGraph Integration: Tally Agent + Curator -- Design Spec

## Goal

Refactor the tally agent and curator to use LangGraph for smarter failure diagnosis and self-correcting dataset generation. The tally agent becomes a ReAct agent with tools (paper search, training history lookup). The curator gains a self-correction loop that feeds verification failures back to the generator with specific feedback instead of discarding pairs.

## Scope

- Tally agent: rewrite as LangGraph ReAct agent
- Curator: add LangGraph self-correction loop
- Orchestrator: minor update to pass new config values
- All other components: unchanged

---

## Tally Agent -- LangGraph ReAct Agent

### Current State

The tally agent (`tally_agent.py`) sends a single massive prompt to gpt-oss:120b via ChatOllama asking it to analyze, cluster, diagnose, prioritize, and generate search queries in one shot. If parsing fails after 3 retries, it falls back to crude word-counting (`fallback_analysis()`).

### New Architecture

A LangGraph ReAct agent that decides its own investigation path. The agent receives failed benchmark questions and cycle history, then freely uses tools to investigate before submitting its structured analysis.

### Tools

#### `search_semantic_scholar`

```python
@tool
def search_semantic_scholar(query: str, max_results: int = 5) -> str:
    """Search Semantic Scholar for papers on a topic.

    Args:
        query: Search query (e.g., "quantum decoherence T1 T2 relaxation")
        max_results: Maximum papers to return (default 5)

    Returns:
        JSON string with list of papers: [{title, abstract, citation_count, year, paper_id}]
    """
```

Uses the existing `sdgs/scrape.py` `_search_semantic_scholar()` function internally. Respects existing rate limiting (`_rate_limit("semantic_scholar", 1.1)`).

#### `query_training_history`

```python
@tool
def query_training_history(query_type: str = "all") -> str:
    """Look up what the model was already trained on in previous cycles.

    Args:
        query_type: One of:
            - "all": Full cycle history (gaps targeted, datasets generated, outcomes)
            - "gaps": List of all knowledge gaps targeted and their outcomes
            - "datasets": Paths and sizes of all curated datasets

    Returns:
        JSON string with training history.
    """
```

**File discovery:** The tool receives the log directory path and history window via closure at construction time. It reads:
- `{log_dir}/loop_log.jsonl` via `CycleLogger.get_cycle_history(last_n=history_window)`
- Dataset paths from each cycle's `dataset_path` field in the log

```python
def make_training_history_tool(log_dir: str, history_window: int) -> BaseTool:
    """Factory that creates the tool with bound log paths."""
    logger = CycleLogger(log_dir=log_dir)

    @tool
    def query_training_history(query_type: str = "all") -> str:
        history = logger.get_cycle_history(last_n=history_window)
        # ... format and return based on query_type

    return query_training_history
```

#### `submit_analysis`

```python
@tool
def submit_analysis(analysis_json: str) -> str:
    """Submit the final failure analysis. This ends the agent's investigation.

    Args:
        analysis_json: JSON string matching this schema:
            {
                "clusters": [
                    {
                        "gap_description": "short label for the knowledge gap",
                        "root_cause": "explanation of why the model fails here",
                        "affected_questions": [0, 1, 5],
                        "priority_score": 0.0-1.0
                    }
                ],
                "search_queries": ["query 1", "query 2", ...],
                "generation_guidance": "instructions for generating training data"
            }

    Returns:
        "Analysis submitted successfully" or validation error message.
    """
```

The tool validates the JSON against the schema. If invalid, it returns an error message describing what's wrong so the agent can fix and resubmit.

### Agent System Prompt

The system prompt defines the agent's role as a benchmark failure diagnostician with access to tools. It instructs the agent to:

1. Review the failed questions
2. Use `query_training_history` to understand what was already tried
3. Form hypotheses about knowledge gaps
4. Use `search_semantic_scholar` to verify paper availability for each hypothesis
5. Call `submit_analysis` with the final diagnosis

The agent is free to call tools in any order and as many times as needed within limits.

### Guardrails

| Parameter | Value | Behavior on limit |
|-----------|-------|-------------------|
| Max tool calls | 20 (configurable) | LangGraph `recursion_limit` stops the agent. Fall back to `fallback_analysis()` |
| Timeout | 10 minutes (configurable) | Implemented via `signal.alarm` (Unix) or threading timer. Fall back to `fallback_analysis()` |
| Output validation | JSON schema check in `submit_analysis` tool | Tool returns error message; agent can fix and resubmit (counted against tool call limit) |
| Complete failure | Agent exits without calling `submit_analysis` | Use `fallback_analysis()` from existing code |

### LangGraph Implementation

```python
from langgraph.prebuilt import create_react_agent
from langchain_ollama import ChatOllama

def run_tally(failed_questions, history, model, max_tool_calls, timeout_seconds, log_dir, history_window):
    llm = ChatOllama(model=model, temperature=0.1)

    tools = [
        search_semantic_scholar,
        make_training_history_tool(log_dir, history_window),
        submit_analysis,
    ]

    agent = create_react_agent(
        model=llm,
        tools=tools,
        prompt=TALLY_SYSTEM_PROMPT,
    )

    # Run with recursion_limit as the tool call cap
    result = agent.invoke(
        {"messages": [build_user_message(failed_questions, history)]},
        config={"recursion_limit": max_tool_calls * 2},  # *2 because each tool call = 2 steps (call + response)
    )

    # Extract the submitted analysis from the agent's tool call history
    # If submit_analysis was never called, fall back
```

### Interface

The public interface adds two optional parameters (backward-compatible via defaults):

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
) -> dict[str, Any]:
```

Returns the same `{"clusters": [...], "search_queries": [...], "generation_guidance": "..."}` structure.

---

## Curator -- LangGraph Self-Correction Loop

### Current State

The curator (`curator.py`) generates chain-of-thought pairs from paper text, runs 3-layer verification (citation matching, NLI entailment, chunk tracing), and discards any pair that fails. Failed pairs are logged to `curation_rejects.jsonl` but their feedback is never used.

### New Architecture

The bulk generation loop stays as plain Python (no tool call limits, no artificial caps). The verification-retry cycle for each individual pair becomes a LangGraph graph that feeds failure reasons back to the generator.

### Self-Correction Graph

```
                    +------------------+
                    |  Generate pair   |  gpt-oss:120b reads paper text,
                    |  from paper text |  generates instruction + CoT response
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Verify          |  Run ALL 3 checks, collect
                    |  (all 3 layers)  |  all feedback at once
                    +--------+---------+
                             |
                      +------+------+
                      |             |
                   PASS           FAIL
                      |             |
               +------v---+  +-----v-----------+
               |  Accept   |  |  Build feedback  |
               |  into     |  |  from ALL failed |
               |  dataset  |  |  checks          |
               +----------+  +-----+-------------+
                                    |
                             attempt < 3?
                              |         |
                             YES        NO
                              |         |
                    +---------v--+  +---v--------+
                    |  Regenerate |  |  Discard   |
                    |  with       |  |  to rejects|
                    |  feedback   |  |  log       |
                    +--------+---+  +------------+
                             |
                      back to Verify
```

### Verification Runs All 3 Checks

Unlike the current short-circuit approach (stop on first failure), the self-correction loop runs ALL three checks on every attempt. This collects complete feedback so the model can fix everything at once instead of playing whack-a-mole (fix citation, retry, then find entailment issue, retry again...).

### Feedback Construction

Each verification layer produces specific, actionable feedback when it fails. All failures are combined into one feedback message.

**Citation matching feedback:**
```
CITATION ERROR: Citation [Paper: 'Quantum Decoherence', Section 7] not found.
Available sections in this paper: 1. Introduction, 2. T1 Relaxation, 3. T2 Dephasing, 4. Experimental Methods.
Use actual section references from the paper.
```

**NLI entailment feedback:**
```
FACTUAL ERROR: Step 3 claims 'T1 is always longer than T2' but the source paper states
'T2 <= T1 with equality in specific regimes' (found in paragraph 12).
Correct the claim to match the source material.
```

**Chunk tracing feedback:**
```
UNGROUNDED CONTENT: Step 5 about 'spin-orbit coupling' has no grounding in the source paper.
The paper covers: decoherence mechanisms, relaxation times, measurement techniques.
Remove this step or replace with content from the paper.
```

### Feedback Injection into Regeneration Prompt

The regeneration prompt appends feedback to the original generation prompt:

```python
regeneration_prompt = f"""{original_generation_prompt}

PREVIOUS ATTEMPT (rejected):
{json.dumps(previous_pair)}

ERRORS FOUND:
{combined_feedback}

Generate a corrected version. Fix ALL errors listed above. Respond with JSON:
{{"instruction": "...", "response": "..."}}
"""
```

The full original prompt (with paper text) is preserved so the model still has the source material. The previous attempt and specific errors are appended so it knows what to fix.

### Verification Model Loading

DeBERTa (NLI) and MiniLM (embeddings) are loaded ONCE at the start of the `generate_pairs()` call and shared across all pairs and all retry attempts. They are NOT reloaded per pair or per retry. This is critical for performance -- these models stay in VRAM for the entire curation phase alongside gpt-oss:120b (total ~430MB for both verification models).

```python
def generate_pairs(papers, tally_metadata, model, min_pairs, verification_config):
    # Load verification models ONCE
    embed_model = SentenceTransformer(verification_config["embedding_model"])
    nli_pipeline = pipeline("zero-shot-classification", model=verification_config["entailment_model"])

    # Bulk loop -- plain Python, no limits
    while len(accepted) < min_pairs:
        # LangGraph self-correction loop for this pair
        # Uses pre-loaded embed_model and nli_pipeline
        ...
```

### Bulk Generation Flow

The LangGraph self-correction loop handles individual pairs. The outer bulk loop is plain Python:

```python
while len(accepted) < min_pairs:
    # Pick a cluster and paper (plain Python)
    # Enter LangGraph self-correction loop for this pair
    #   -> generates, verifies (all 3 checks), retries up to 3x with feedback
    #   -> returns accepted pair or None (discarded)
    # No tool call limits on the outer loop
    # No cap on total pairs generated
```

### Key Guarantees

- **No hallucination:** Generation prompt always includes paper text. Model reads from source, not its own knowledge.
- **No tool call limits on bulk generation:** LangGraph is only used for the verify-retry loop per pair, not for the outer generation loop.
- **Verification models loaded once:** DeBERTa and MiniLM loaded at start, shared across all pairs.
- **All four paper sources:** Semantic Scholar, arXiv, OpenAlex, CORE enabled by default.
- **Complete feedback per attempt:** All 3 checks run, all failures collected, model fixes everything at once.

### Interface

The public interface does not change:

```python
def generate_pairs(
    papers: list[dict],
    tally_metadata: dict[str, Any],
    model: str = "gpt-oss:120b",
    min_pairs: int = 1000,
    verification_config: dict | None = None,
) -> tuple[list[dict], list[dict]]:
```

Returns `(accepted_pairs, rejected_pairs)`. The orchestrator calls it exactly the same way.

---

## Paper Sources

Enable all four sources in the default config:

```yaml
retrieval:
  sources:
    - semantic_scholar
    - arxiv
    - openalex
    - core
  max_papers_per_cluster: 10
```

The existing `sdgs/scrape.py` already supports all four. The retriever (`retriever.py`) passes the `sources` list through to `search_papers()`. No code changes needed in the retriever -- just config.

---

## Configuration Changes

New fields in `configs/closed_loop.yaml`:

```yaml
tally:
  model: "gpt-oss:120b"
  provider: "ollama"
  max_clusters: 10
  history_window: 5
  max_retries: 3
  max_tool_calls: 20          # NEW: max ReAct tool calls per tally run
  timeout_seconds: 600        # NEW: tally agent timeout

curation:
  model: "gpt-oss:120b"
  provider: "ollama"
  min_pairs_per_cycle: 1000
  max_pairs_per_cycle: -1
  format: "chain-of-thought"
  max_retries_per_pair: 3     # NEW: self-correction attempts before discard
  verification:
    citation_matching: true
    entailment_model: "microsoft/deberta-v3-base-mnli"
    entailment_min_ratio: 0.5
    embedding_model: "all-MiniLM-L6-v2"
    chunk_similarity_threshold: 0.3
    rejects_log: "curation_rejects.jsonl"

retrieval:
  sources:                    # CHANGED: all four sources enabled
    - semantic_scholar
    - arxiv
    - openalex
    - core
  max_papers_per_cluster: 10
```

---

## What Changes

### Modified Files

| File | Change |
|------|--------|
| `sdgs/loop/tally_agent.py` | Rewrite: LangGraph ReAct agent with 3 tools, guardrails, fallback |
| `sdgs/loop/curator.py` | Add LangGraph self-correction loop with feedback construction, load verification models once |
| `sdgs/loop/config_v2.py` | Add `max_tool_calls`, `timeout_seconds` to TallyConfig; add `max_retries_per_pair` to CurationConfig |
| `sdgs/loop/orchestrator_v2.py` | Pass new config values (`max_tool_calls`, `timeout_seconds`, `log_dir`, `history_window`) to `run_tally()` |
| `configs/closed_loop.yaml` | Add new config fields, enable all 4 paper sources |
| `configs/closed_loop_test.yaml` | Add new config fields with test values |
| `tests/loop/test_tally_agent.py` | Update tests for new LangGraph-based implementation |
| `tests/loop/test_curator.py` | Add tests for self-correction feedback construction |

### New Files

| File | Purpose |
|------|---------|
| `sdgs/loop/tally_tools.py` | Tool implementations: `search_semantic_scholar`, `make_training_history_tool`, `submit_analysis` |
| `tests/loop/test_tally_tools.py` | Tests for tally tools |

### Unchanged Files

| File | Why |
|------|-----|
| `sdgs/loop/benchmark_runner.py` | Not involved |
| `sdgs/loop/quality_gate.py` | Not involved |
| `sdgs/loop/state_v2.py` | Not involved |
| `sdgs/loop/retriever.py` | No code change -- receives more sources from config |
| `sdgs/loop/vram.py` | Not involved |
| `sdgs/loop/cycle_logger.py` | Not involved (read by `query_training_history` tool) |
| `sdgs/loop/email_reporter.py` | Not involved |

---

## Dependencies

`langgraph` must be added as an explicit dependency. It is NOT a transitive dependency of `langchain`.

Add to `pyproject.toml` under `[project.optional-dependencies]`:

```toml
loop = [
    "langchain>=0.3",
    "langchain-ollama>=0.3",
    "langgraph>=0.2",
    "langgraph-prebuilt>=0.1",
    "lm-eval>=0.4",
    "sentence-transformers>=3.0",
]
```

Verify after install:
```python
from langgraph.prebuilt import create_react_agent  # must work
```
