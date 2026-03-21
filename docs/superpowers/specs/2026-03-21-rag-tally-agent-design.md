# RAG-Enhanced Tally Agent v2 -- Design Spec

**Date:** 2026-03-21
**Status:** Review
**Scope:** Upgrade the Tally Agent from a basic LangChain ReAct agent to a RAG-enhanced diagnostic engine with vector retrieval, evolutionary memory, and post-mortem reasoning traces.

---

## 1. Constraints

| Constraint | Value | Rationale |
|---|---|---|
| Context budget | 32k tokens | 3x 3090 (73GB total), gpt-oss:120b uses ~65GB for weights, ~8GB headroom for KV cache |
| Tally model | gpt-oss:120b via Ollama | Existing infrastructure, MXFP4 quantized |
| Embedding model | Qwen3-Embedding-4B (CPU) | 2560-dim, dense embeddings, keeps GPU VRAM free. Fallback: Qwen3-Embedding-0.6B if 4B CPU latency is prohibitive. Must benchmark before full deployment. |
| Vector DB | ChromaDB (cosine HNSW) | Existing infrastructure, two collections |
| Similarity threshold | 0.42 | Calibrated for Qwen3-4B density in scientific domains |
| Scraping budget | 5 queries, 25 papers per cluster | Balanced against API rate limits and cycle time |
| Auto-index scraped papers | Yes | Organic corpus growth ("Ouroboros philosophy") |
| CoT trace strategy | Post-mortem hybrid (top 10% confident-wrong) | Balances diagnostic depth vs cycle time |

### Context Budget Allocation

```
 2k  system prompt + tool definitions
 4k  failure packets (5-10 questions with CoT traces + logit bias)
 4k  evolutionary ledger results
18k  paper corpus chunks (15-20 chunks)
 4k  agent reasoning + structured output
-----
32k  total
```

---

## 2. System Architecture

```
lm-eval (MMLU-Pro / GPQA)
    |
    v
[POST-MORTEM PIPELINE] -- postmortem.py
    |  1. Filter: top 10% confident-wrong (high log_prob on wrong answer)
    |  2. Enrich: extract top-3 alternative logprobs per failure
    |  3. Trace: Ollama CoT re-run on filtered failures
    |  4. Packetize: {question, correct, wrong, cot_trace, top_logprobs, task}
    |
    v
Failure Packets (5-10 enriched failures)
    |
    v
+----------------------------------------------------------------+
|  RAG-ENHANCED TALLY AGENT (gpt-oss:120b, 32k context)         |
|                                                                 |
|  Step 1: Query evolutionary ledger (FIRST)                      |
|     -> "Have we seen this failure pattern before?"              |
|     -> tool: query_evolution_ledger(query, k=10)               |
|                                                                 |
|  Step 2: Query paper corpus                                     |
|     -> tool: query_paper_corpus(query, k=15)                   |
|     -> returns chunks WITH similarity scores                    |
|                                                                 |
|  Step 3: If best score < 0.42, scrape                          |
|     -> tool: scrape_and_index(query, max_papers=25)            |
|     -> auto-indexes into ChromaDB                              |
|     -> returns commit message: "Added N papers on [Topic]"     |
|     -> re-query paper corpus                                    |
|                                                                 |
|  Step 4: Synthesize diagnosis                                   |
|     -> cite specific paper sections                            |
|     -> reference historical conflicts from ledger              |
|     -> submit structured analysis                              |
|                                                                 |
|  Tools:                                                         |
|     1. query_evolution_ledger(query, k) -> ledger hits         |
|     2. query_paper_corpus(query, k) -> chunks + scores         |
|     3. scrape_and_index(query, max_papers) -> commit msg       |
|     4. query_training_history(type) -> cycle log               |
|     5. submit_analysis(json) -> validated output               |
+----------------------------------------------------------------+
    |
    v
Output: tally_metadata
    |
    +-> Write diagnosis to evolutionary ledger (ChromaDB)
    +-> Pass search_queries to retriever
    +-> Pass generation_guidance to curator
```

---

## 3. Component Specifications

### 3.1 Post-Mortem CoT Pipeline

**New file:** `sdgs/loop/postmortem.py`

**Purpose:** Generate enriched failure packets from benchmark results.

**Interface:**
```python
def run_postmortem(
    per_question: list[dict],
    model: str = "gpt-oss:120b",
    provider: str = "ollama",
    top_percent: float = 0.10,
    max_traces: int = 10,
) -> list[dict]:
    """
    Filter benchmark failures by confidence, generate CoT traces.

    Returns list of failure packets:
    [
        {
            "task": "mmlu_pro_physics",
            "question": "...",
            "correct_answer": "B",
            "wrong_answer": "A",
            "log_prob_wrong": -0.12,
            "choice_logprobs": [
                {"choice": "A", "logprob": -0.12},
                {"choice": "B", "logprob": -0.15},
                {"choice": "C", "logprob": -2.8},
            ],
            // NOTE: These are answer-choice-level log-likelihoods from
            // lm-eval's filtered_resps, NOT per-token distributions.
            // lm-eval runs loglikelihood requests per answer option.
            "cot_trace": "Step 1: The question asks about...\nStep 2: ...",
            "confidence_rank": 1,
        },
        ...
    ]
    """
```

**Pipeline:**
1. Extract all failed questions from `per_question` where `passed == False`
2. Sort by `log_prob` of wrong answer (highest = most confident = most interesting)
3. Take top `top_percent` (capped at `max_traces`)
4. For each, extract answer-choice log-likelihoods from lm-eval `filtered_resps` (one logprob per answer option A/B/C/D, not per-token)
5. Run Ollama generate with CoT system prompt on each filtered failure
6. Package into failure packets

**CoT System Prompt** (parameterized by benchmark task domain):
```
You are solving a {domain} question. Think step by step.
Show your complete reasoning process before giving your final answer.
Be explicit about which principles, definitions, and formulas you apply at each step.
```

Domain mapping: `mmlu_pro_physics` -> "physics", `gpqa` -> "graduate-level science",
`arc_challenge` -> "science", etc. Derived from benchmark task name.

**Integration point:** Called by orchestrator between EVALUATING and TALLYING stages.

### 3.2 Embedding Migration

**Model:** `Qwen/Qwen3-Embedding-4B` via `sentence-transformers` or HuggingFace

**Runtime:** CPU-only (keeps GPU VRAM free for gpt-oss:120b inference)

**Dimensions:** 2560

**Changes to `knowledge_service.py`:**
- Replace `all-MiniLM-L6-v2` with `Qwen3-Embedding-4B`
- Update `get_embeddings()` singleton to load new model on CPU
- Force `device="cpu"` in embedding model initialization

**ChromaDB Collection Config:**
Both collections must use cosine distance (not the default L2):
```python
collection = client.get_or_create_collection(
    name="ouroboros_papers",  # or "ouroboros_ledger"
    metadata={"hnsw:space": "cosine"},
)
```

**Migration Strategy:**
1. Back up existing ChromaDB data directory
2. Delete old `ouroboros_papers` collection (384-dim embeddings are incompatible)
3. Re-create collection with `hnsw:space = cosine`
4. Re-index all existing papers with new embedding model
5. Create new `ouroboros_ledger` collection with same config

**Vector Drift Guard:** As the ledger grows to tens of thousands of entries, monitor query latency. ChromaDB HNSW with cosine space handles 2560-dim well up to ~100k entries. Beyond that, consider dimensionality reduction or collection sharding.

### 3.3 Retrieval Pipeline (Agent Tools)

#### Tool 1: `query_paper_corpus`

**Purpose:** Semantic search against local paper chunks.

```python
@tool
def query_paper_corpus(query: str, k: int = 15) -> str:
    """Search the local scientific paper corpus for relevant chunks.

    Returns chunks with similarity scores. If the best score is below
    0.42, consider using scrape_and_index to fetch fresh papers.
    """
```

**Returns:** JSON array of `{text, score, metadata: {paper_title, paper_id, chunk_index}}`

**Key behavior:** Returns similarity scores so the agent can decide whether to scrape.

#### Tool 2: `query_evolution_ledger`

**Purpose:** Search the evolutionary memory for historical precedent.

```python
@tool
def query_evolution_ledger(query: str, k: int = 10) -> str:
    """Search the evolutionary ledger for past failure patterns,
    remediation attempts, and their outcomes.

    Query this BEFORE searching the paper corpus to check if
    this failure pattern has been seen and addressed before.
    """
```

**Returns:** JSON array of `{text, score, metadata: {cycle, type, gate_passed, score_delta}}`

**Entry types in ledger:**
- `failure_cluster`: gap_description + root_cause from past tally runs
- `remediation`: what was tried + outcome (score delta, gate pass/fail)
- `effective_query`: search queries that led to gate-passing cycles

#### Tool 3: `scrape_and_index`

**Purpose:** Fallback retrieval when local corpus is insufficient.

```python
@tool
def scrape_and_index(query: str, max_papers: int = 25) -> str:
    """Scrape external sources for papers matching the query,
    then index them into the local ChromaDB corpus.

    Use this when query_paper_corpus returns scores below 0.42.
    Returns a commit message summarizing what was added.
    """
```

**Pipeline:**
1. Query arXiv, Semantic Scholar, OpenAlex, CORE (max 5 queries, 25 papers per cluster)
2. Deduplicate against existing ChromaDB entries (by content hash)
3. Download PDFs, extract text (PyMuPDF), chunk (RecursiveCharacterTextSplitter)
4. Embed chunks with Qwen3-Embedding-4B (CPU)
5. Insert into `ouroboros_papers` collection
6. Return commit message: `"Indexed 12 new papers on [quantum decoherence]. Top sources: arXiv (7), Semantic Scholar (5). ChromaDB now contains N total chunks."`

**Deduplication:** Content hash (MD5 of normalized text) -- matches existing `VectorStoreManager._file_hash()` pattern.

**Reuse:** `scrape_and_index` delegates to the existing `retriever.py` pipeline for paper search
(`search_papers()`) and PDF text extraction (`extract_paper_text()`). It adds the indexing step
by calling into `knowledge_service.py`'s `VectorStoreManager`. This avoids reimplementing search/extraction logic.

#### Tool 4: `query_training_history` (existing, unchanged)

Same as current implementation. Reads from `CycleLogger`.

#### Tool 5: `submit_analysis` (enhanced)

Same validation pattern, but extended schema:

```python
{
    "clusters": [
        {
            "gap_description": "Quantum Gate Fidelity - Cross-talk interference",
            "root_cause": "Model confuses single-qubit gate errors with...",
            "affected_questions": ["mmlu_q_102", "gpqa_q_47"],
            "priority_score": 0.85,
            "cited_papers": [
                {"paper_id": "arxiv:2401.12345", "section": "Section 3.2", "relevance": "Defines cross-talk..."}
            ],
            "historical_conflicts": [
                {"cycle": 4, "action": "Added Lindblad pairs", "outcome": "score -1.2pp", "recommendation": "Pivot to density matrix examples"}
            ]
        }
    ],
    "search_queries": ["quantum cross-talk gate fidelity calibration", ...],
    "generation_guidance": "Focus on problems that require distinguishing..."
}
```

### 3.4 Evolutionary Ledger

**ChromaDB Collection:** `ouroboros_ledger`

**Config:** `hnsw:space = cosine`, embedding model = Qwen3-Embedding-4B

**Write Path (end of each tally run):**

**API:** Uses `langchain_chroma.Chroma` wrapper (consistent with `knowledge_service.py`),
not the raw ChromaDB client. Use `similarity_search_with_relevance_scores()` for reads
(returns cosine similarity 0-1, higher = more similar). The 0.42 threshold applies to
these scores directly.

After the tally agent completes, the orchestrator writes entries to the ledger:

```python
def write_to_ledger(cycle: int, tally_metadata: dict, gate_passed: bool, score_delta: float):
    """Persist cycle diagnosis into the evolutionary ledger."""

    entries = []

    # 1. Failure clusters
    for cluster in tally_metadata.get("clusters", []):
        entries.append({
            "text": f"Failure: {cluster['gap_description']}. Root cause: {cluster['root_cause']}",
            "metadata": {
                "type": "failure_cluster",
                "cycle": cycle,
                "priority": cluster["priority_score"],
                "gate_passed": gate_passed,
                "score_delta": score_delta,
            }
        })

    # 2. Remediation record
    entries.append({
        "text": f"Cycle {cycle}: Targeted {', '.join(c['gap_description'] for c in tally_metadata.get('clusters', []))}. "
                f"Score delta: {score_delta:+.1f}pp. Gate: {'PASSED' if gate_passed else 'FAILED'}.",
        "metadata": {
            "type": "remediation",
            "cycle": cycle,
            "gate_passed": gate_passed,
            "score_delta": score_delta,
        }
    })

    # 3. Effective queries (only if gate passed)
    if gate_passed:
        for query in tally_metadata.get("search_queries", []):
            entries.append({
                "text": f"Effective query (gate passed, +{score_delta:.1f}pp): {query}",
                "metadata": {
                    "type": "effective_query",
                    "cycle": cycle,
                    "score_delta": score_delta,
                }
            })

    # Embed and insert
    ledger_collection.add(
        documents=[e["text"] for e in entries],
        metadatas=[e["metadata"] for e in entries],
        ids=[f"cycle_{cycle}_{i}" for i in range(len(entries))],
    )
```

**Read Path:** Via `query_evolution_ledger` tool (semantic search).

### 3.5 Enhanced Tally Agent

**File:** `sdgs/loop/tally_agent.py` (modified)

**System Prompt (updated):**

```
You are an expert AI benchmark diagnostician with access to a scientific paper
corpus, an evolutionary memory of past training cycles, and external research APIs.

You will receive a set of "failure packets" -- benchmark questions the model answered
incorrectly. Each packet includes the question, correct answer, wrong answer, the
model's chain-of-thought reasoning trace, and the top-3 token logprobabilities.

YOUR WORKFLOW (follow this order):

1. ANALYZE the failure packets. Look for patterns in the CoT traces:
   - Where does the reasoning go wrong?
   - Is the model confusing similar concepts?
   - Is it applying the wrong formula or principle?
   - Check the logprob distribution: if top-2 tokens are close (within 0.1),
     the model is unstable on this concept, not just wrong.

2. QUERY THE EVOLUTIONARY LEDGER FIRST (query_evolution_ledger).
   Check if this failure pattern has appeared in past cycles.
   - If a similar gap was addressed before and scores DROPPED, do NOT repeat
     that approach. Recommend an alternative.
   - If a similar gap was addressed and scores IMPROVED, note what worked.

3. QUERY THE PAPER CORPUS (query_paper_corpus).
   Search for the physical principles underlying each failure cluster.
   - Check the similarity scores in the results.
   - If the best score is below 0.42, the local corpus lacks sufficient
     coverage. Use scrape_and_index to fetch fresh papers, then re-query.

4. SYNTHESIZE your diagnosis. For each failure cluster:
   - Cite specific paper sections that explain the correct reasoning.
   - Reference any historical conflicts from the ledger.
   - Generate precise search queries for the retrieval step.
   - Write generation guidance describing what training examples would help.

5. SUBMIT your analysis via submit_analysis with the complete JSON structure.

IMPORTANT:
- Always cite papers by paper_id and section when making claims.
- Always check the ledger before recommending an approach.
- If you use scrape_and_index, re-query the paper corpus afterward.
- Your search_queries should be highly specific, not generic.
  BAD: "quantum physics"
  GOOD: "non-Markovian decoherence correction density matrix formalism"
```

**Agent Construction:**
```python
from langgraph.prebuilt import create_react_agent

tools = [
    query_evolution_ledger,   # check history first
    query_paper_corpus,       # local RAG
    scrape_and_index,         # fallback retrieval
    query_training_history,   # cycle log
    submit_analysis,          # structured output
]

agent = create_react_agent(llm, tools)
```

### 3.6 Orchestrator Integration

**Modified stages in `orchestrator_v2.py`:**

Current 8-stage cycle becomes 9 stages (POST_MORTEM inserted before TALLYING).

The existing orchestrator runs TALLYING first in each cycle, consuming `per_question`
from the **previous** cycle's EVALUATING stage (or BASELINE for cycle 1). POST_MORTEM
slots in before TALLYING to enrich those failure results with CoT traces.

```
[0] BASELINE      -> benchmark base model (cycle 0 only, produces per_question)
[1] POST_MORTEM   -> CoT traces on confident-wrong failures from prior eval  [NEW]
[2] TALLYING      -> RAG-enhanced tally agent (consumes enriched packets)
[3] RETRIEVING    -> retrieve papers using tally search_queries
[4] CURATING      -> generate training pairs with 3-layer verification
[5] TRAINING      -> fine-tune with LoRA
[6] MERGING       -> merge adapter into base model
[7] EVALUATING    -> benchmark merged model (produces per_question for next cycle)
[8] GATING        -> accept or rollback, write to evolutionary ledger  [MODIFIED]
```

**Changes to GATING stage:** After gate decision, call `write_to_ledger()` to persist the cycle's diagnosis and outcome into ChromaDB.

**Note:** `state_v2.py` must be updated -- add `POST_MORTEM = "post_mortem"` to the `Stage` enum.

---

## 4. Consolidated Logging

### 4.1 Log Schema

All tally-related events are written to `loop_log.jsonl` in a flat, searchable structure:

```json
{
  "timestamp": "2026-03-21T14:25:01Z",
  "event": "tally_tool_call",
  "cycle_id": 12,
  "trace_id": "arc_q_402",
  "hardware": {
    "vram_gb": 68.4,
    "ram_gb": 14.2,
    "gpu_temp_c": 78
  },
  "vector_metrics": {
    "top_score": 0.39,
    "threshold": 0.42,
    "status": "fallback_triggered",
    "latency_ms": 142
  },
  "action": "scrape_and_index",
  "query": "non-local quantum entanglement decoherence proof"
}
```

### 4.2 Event Types

| Event | When | Key Fields |
|---|---|---|
| `postmortem_start` | CoT pipeline begins | `cycle_id`, `num_failures`, `num_selected` |
| `postmortem_trace` | Each CoT trace generated | `trace_id`, `task`, `confidence_rank`, `latency_ms` |
| `tally_start` | Tally agent begins | `cycle_id`, `num_packets`, `hardware` |
| `tally_tool_call` | Each tool invocation | `action`, `query`, `vector_metrics`, `hardware` |
| `tally_scrape` | Scrape triggered | `query`, `papers_added`, `source_breakdown` |
| `tally_complete` | Tally agent finishes | `num_clusters`, `num_queries`, `total_latency_ms` |
| `ledger_write` | Entries written to ledger | `cycle_id`, `num_entries`, `entry_types` |
| `heartbeat` | Every 30s during inference | `status`, `hardware` |

### 4.3 Implementation

**Library:** `structlog` for structured logging, outputs to JSONL.

**Hardware Snapshots:** Use `pynvml` (already a torch dependency) to capture VRAM/temp at each event:

```python
import pynvml

def hardware_snapshot() -> dict:
    pynvml.nvmlInit()
    gpus = []
    total_vram_used = 0
    max_temp = 0
    for i in range(pynvml.nvmlDeviceGetCount()):
        handle = pynvml.nvmlDeviceGetHandleByIndex(i)
        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
        temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
        total_vram_used += mem.used
        max_temp = max(max_temp, temp)
    pynvml.nvmlShutdown()

    import psutil
    ram = psutil.virtual_memory()

    return {
        "vram_gb": round(total_vram_used / 1e9, 1),
        "ram_gb": round(ram.used / 1e9, 1),
        "gpu_temp_c": max_temp,
    }
```

### 4.4 OOM Heartbeat

**Purpose:** Detect silent crashes during long inference calls.

**Implementation:** Background daemon thread, started before tally agent invocation, stopped after.

```python
import threading

class OOMHeartbeat:
    def __init__(self, logger, interval=30):
        self.logger = logger
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        pynvml.nvmlInit()  # init once, not per-snapshot
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        pynvml.nvmlShutdown()

    def _run(self):
        while not self._stop.wait(self.interval):
            hw = hardware_snapshot(skip_nvml_init=True)
            self.logger.info("heartbeat", status="alive", hardware=hw)
```

### 4.5 WandB Integration

At the end of each tally run, log summary metrics to WandB:
- `tally/num_clusters`
- `tally/num_scrape_fallbacks`
- `tally/avg_similarity_score`
- `tally/ledger_cache_hits` (how often ledger had relevant history)
- `tally/total_latency_s`
- `tally/peak_vram_gb`

---

## 5. Configuration

### 5.1 TallyConfig Updates

```python
@dataclass
class TallyConfig:
    # Existing
    model: str = "gpt-oss:120b"
    provider: str = "ollama"
    max_clusters: int = 10
    history_window: int = 5
    max_retries: int = 3
    max_tool_calls: int = 20
    timeout_seconds: int = 600

    # New: Post-mortem
    postmortem_top_percent: float = 0.10
    postmortem_max_traces: int = 10

    # New: RAG retrieval
    embedding_model: str = "Qwen/Qwen3-Embedding-4B"
    embedding_device: str = "cpu"
    similarity_threshold: float = 0.42
    corpus_top_k: int = 15
    ledger_top_k: int = 10

    # New: Scraping fallback
    scrape_max_queries: int = 5
    scrape_max_papers: int = 25
    scrape_sources: list = field(default_factory=lambda: [
        "arxiv", "semantic_scholar", "openalex", "core"
    ])
    auto_index: bool = True

    # New: Logging
    heartbeat_interval: int = 30
    log_level: str = "DEBUG"
```

### 5.2 YAML Config Block

```yaml
tally:
  model: "gpt-oss:120b"
  provider: "ollama"
  max_clusters: 10
  timeout_seconds: 600

  # Post-mortem CoT
  postmortem_top_percent: 0.10
  postmortem_max_traces: 10

  # RAG retrieval
  embedding_model: "Qwen/Qwen3-Embedding-4B"
  embedding_device: "cpu"
  similarity_threshold: 0.42
  corpus_top_k: 15
  ledger_top_k: 10

  # Scraping fallback
  scrape_max_queries: 5
  scrape_max_papers: 25
  auto_index: true

  # Logging
  heartbeat_interval: 30
  log_level: "DEBUG"
```

---

## 6. Data Flow Summary

```
Cycle N:

EVALUATING
  |-- lm-eval runs MMLU-Pro / GPQA
  |-- Outputs: per_question (with log_probs)
  v

POST_MORTEM
  |-- Filter: top 10% confident-wrong failures
  |-- Enrich: extract top-3 logprobs per failure
  |-- Trace: Ollama CoT re-run (5-10 questions)
  |-- Output: failure_packets[]
  v

TALLYING (RAG-Enhanced)
  |-- Start OOM heartbeat thread
  |-- Build prompt: system + failure_packets (~6k tokens)
  |-- Agent Step 1: query_evolution_ledger()  (~4k tokens)
  |     "Have we seen decoherence sign-flip before?"
  |     -> "Cycle 4: Lindblad pairs, -1.2pp. Cycle 7: density matrix, +3.4pp"
  |-- Agent Step 2: query_paper_corpus()  (~18k tokens)
  |     "quantum decoherence sign error density matrix"
  |     -> top score: 0.39 (below 0.42)
  |-- Agent Step 3: scrape_and_index()
  |     "non-Markovian decoherence density matrix correction"
  |     -> "Indexed 14 papers. arXiv (9), S2 (5)."
  |-- Agent Step 4: query_paper_corpus() (re-query)
  |     -> top score: 0.71. Returns 15 relevant chunks.
  |-- Agent Step 5: submit_analysis()
  |     -> clusters with cited_papers + historical_conflicts
  |-- Stop heartbeat thread
  |-- Log tally_complete event
  v

GATING (after training + evaluation)
  |-- write_to_ledger(): persist clusters, remediation, effective queries
  v

Next Cycle: ledger is richer, corpus has grown
```

---

## 7. Files Changed / Created

| File | Action | Purpose |
|---|---|---|
| `sdgs/loop/postmortem.py` | **Create** | Post-mortem CoT pipeline |
| `sdgs/loop/tally_agent.py` | **Modify** | RAG-enhanced agent with new tools, updated prompt |
| `sdgs/loop/tally_tools.py` | **Modify** | Add 3 new tools (ledger, corpus, scrape), enhance submit_analysis; new fields (`cited_papers`, `historical_conflicts`) are optional in validation |
| `sdgs/loop/evolutionary_ledger.py` | **Create** | Ledger read/write operations via LangChain Chroma |
| `sdgs/loop/tally_logger.py` | **Create** | Structured logging with structlog, hardware snapshots, heartbeat |
| `sdgs/loop/orchestrator_v2.py` | **Modify** | Add POST_MORTEM stage, ledger write in GATING, WandB tally metrics |
| `sdgs/loop/config_v2.py` | **Modify** | Extended TallyConfig with new fields |
| `sdgs/loop/state_v2.py` | **Modify** | Add `POST_MORTEM` to Stage enum |
| `sdgs/web/services/knowledge_service.py` | **Modify** | Swap embedding model, add cosine HNSW config |
| `sdgs/loop/benchmark_runner.py` | **Modify** | Extract answer-choice log-likelihoods from `filtered_resps` into per_question |

---

## 8. Migration Steps

1. Install dependencies: `structlog`, `pynvml`, `psutil`, Qwen3-Embedding-4B model weights
2. Back up existing ChromaDB data directory
3. Delete and re-create `ouroboros_papers` collection with `hnsw:space = cosine`
4. Re-index all existing papers with Qwen3-Embedding-4B
5. Create `ouroboros_ledger` collection with same config
6. Update `closed_loop.yaml` with new tally config block
7. First run: set `log_level: "DEBUG"` to capture full diagnostic output

---

## 9. Risk Mitigations

| Risk | Mitigation |
|---|---|
| OOM during 32k context fill | Heartbeat thread detects silent crash; hardware snapshots at each event |
| Qwen3-4B CPU embedding latency too slow | Benchmark before deployment. If >5s/chunk, fall back to Qwen3-Embedding-0.6B. RAM budget: ~8GB for 4B model weights + working memory. |
| Context budget exceeded on re-query | If scrape triggers a second `query_paper_corpus`, truncate earlier tool results to fit. Total injected context must not exceed 28k tokens (leaving 4k for agent output). |
| ChromaDB performance at scale | Cosine HNSW; monitor query latency in vector_metrics; shard at 100k entries |
| Scraping adds too much latency | Hard cap: 5 queries, 25 papers. Async PDF download where possible |
| Tally agent ignores workflow order | System prompt explicitly instructs ledger-first; tool docstrings reinforce |
| lm-eval doesn't expose log_probs | Extract from `filtered_resps` score field; fallback to answer-only packets if unavailable |
| Global `_submitted_analysis` not thread-safe | Add threading.Lock to protect module-level state in tally_tools.py |
