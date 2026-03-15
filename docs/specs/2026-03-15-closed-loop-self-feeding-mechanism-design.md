# Closed-Loop Self-Feeding Mechanism -- Design Spec

## Goal

Fine-tune a 7-8B model to frontier-competitive performance on a single domain (quantum physics initially) through an autonomous closed loop that iteratively diagnoses knowledge gaps, retrieves authoritative sources, generates targeted chain-of-thought reasoning datasets, and trains from merged checkpoints.

All LLM calls run locally via Ollama (gpt-oss:120b for generation/tally, 7-8B model as the training target). No external LLM APIs. Paper retrieval via Semantic Scholar and arXiv. The loop runs standalone -- no web server or QFTL bridge dependency.

---

## The Cycle

The loop always begins with a baseline benchmark evaluation before any training.

```
First run only:
[0] BASELINE   Benchmark the unmodified base model (GPQA + MMLU + SciBench)
                 |
                 v
[1] TALLY      LangChain agent diagnoses failures, outputs structured metadata
                 |
[2] RETRIEVE   Semantic Scholar / arXiv -- papers on weak areas
                 |
[3] CURATE     gpt-oss:120b generates 1-2k+ chain-of-thought reasoning pairs from papers
                 |
[4] TRAIN      Fresh LoRA on current base model (3 epochs, converge)
                 |
[5] MERGE      Merge LoRA adapter into base model weights
                 |
[6] EVALUATE   Benchmark the merged model (GPQA + MMLU + SciBench)
                 |
[7] GATE       Average benchmark score improved >= 0.5%?
                 |         |
                YES        NO
                 |         |
              KEEP       ROLLBACK to previous checkpoint
                 |         |
                 v         v
              Back to [1]
```

Every cycle after baseline:
```
TALLY -> RETRIEVE -> CURATE -> TRAIN -> MERGE -> EVALUATE -> GATE -> loop
```

---

## Dataset Format: Chain-of-Thought Reasoning

All generated training data uses chain-of-thought reasoning format. Each sample includes the full reasoning trace, not just the final answer.

### Sample Structure

```json
{
  "instruction": "Derive the energy eigenvalues of a quantum harmonic oscillator using the ladder operator approach.",
  "response": "Let me work through this systematically.\n\nWe start with the Hamiltonian H = p²/2m + mω²x²/2.\n\nStep 1: Define the ladder operators.\nWe introduce a = √(mω/2ℏ)(x + ip/mω) and a† = √(mω/2ℏ)(x - ip/mω).\n\nStep 2: Rewrite the Hamiltonian.\nSubstituting, we get H = ℏω(a†a + 1/2). The operator N = a†a is the number operator.\n\nStep 3: Find the eigenvalues.\nSince N|n⟩ = n|n⟩ where n = 0, 1, 2, ..., we have H|n⟩ = ℏω(n + 1/2)|n⟩.\n\nStep 4: Verify the ground state.\na|0⟩ = 0 gives E₀ = ℏω/2, confirming the zero-point energy.\n\nTherefore, the energy eigenvalues are E_n = ℏω(n + 1/2) where n = 0, 1, 2, ...\n\nThe key insight is that the energy levels are equally spaced with separation ℏω, and the ground state has non-zero energy E₀ = ℏω/2 due to the uncertainty principle."
}
```

### What Makes Good Reasoning Data

- Shows the full derivation process, not just the result
- Explains *why* each step follows from the previous
- Identifies key insights and connections between concepts
- Includes verification steps where appropriate
- Grounded in specific paper content (traceable to source)

### What the Tally Agent Diagnoses

The tally agent analyzes failures at the reasoning level:
- "Model knows the formula but applies it to the wrong regime"
- "Model skips the commutator calculation, leading to sign errors"
- "Model confuses creation and annihilation operator actions"
- Not just "model got the wrong answer"

---

## Logging

A persistent log tracks every cycle for both human review and tally agent reference.

### Cycle Log (`loop_log.jsonl`)

One JSON record per cycle, appended after GATE:

```json
{
  "cycle": 3,
  "timestamp": "2026-03-15T14:22:00Z",
  "base_model_version": "v2",
  "dataset_path": "data/loop/cycle3_curated.jsonl",
  "dataset_size": 1247,
  "training": {
    "epochs": 3,
    "final_loss": 0.42,
    "adapter_path": "outputs/cycle3/final_adapter/"
  },
  "benchmarks": {
    "gpqa_diamond": 38.0,
    "mmlu_college_physics": 71.0,
    "mmlu_conceptual_physics": 65.0,
    "scibench": 58.0,
    "average": 58.0
  },
  "previous_average": 55.7,
  "gate_delta": 2.3,
  "gate_passed": true,
  "merged_model_path": "models/merged/base-v3/",
  "tally_summary": {
    "clusters_targeted": 3,
    "top_gaps": ["decoherence mechanisms", "perturbation theory", "band structure"],
    "papers_retrieved": 25
  }
}
```

### Project Log (`loop_projects.json`)

Tracks high-level project runs (a project = one domain being trained):

```json
{
  "project_id": "quantum-physics-001",
  "domain": "quantum_physics",
  "started": "2026-03-15T10:00:00Z",
  "base_model": "Qwen/Qwen2.5-7B-Instruct",
  "baseline_score": 32.5,
  "current_score": 58.0,
  "best_score": 58.0,
  "total_cycles": 3,
  "successful_merges": 2,
  "failed_gates": 1,
  "current_base_version": "v3",
  "status": "running"
}
```

---

## Stage Details

### [0] BASELINE (first run only)

- Benchmark the unmodified base model to establish starting scores
- Run GPQA Diamond, MMLU college_physics, MMLU conceptual_physics, SciBench
- Record as cycle 0 in the log with `gate_passed: null` (no gate on baseline)
- These scores become the reference point for the first cycle's gate comparison
- **VRAM:** Load base model for inference. Unload after benchmarks complete.

### [1] TALLY -- LangChain Diagnosis Agent

The core intelligence of the feedback loop. Runs on gpt-oss:120b via Ollama, orchestrated by LangChain.

#### Architecture

- **Agent type:** ReAct agent via LangChain
- **LLM:** gpt-oss:120b via `langchain-ollama` (`ChatOllama`)
- **Output parsing:** JSON structured output via LangChain output parser with retry on malformed responses (max 3 retries)
- **Error handling:** If the model produces unusable output after retries, log the raw output and fall back to a simplified analysis (top-N failed topics by count)

#### Inputs
- Benchmark results: per-question pass/fail, model outputs, correct answers (extracted from `lm-eval --log_samples` output)
- Previous cycle metadata from `loop_log.jsonl` (what topics were targeted and outcomes)
- Rolling history window (last 5 cycles) to avoid re-targeting solved gaps

#### Agent Process
1. **Analyze** -- For each failed question: why did the model's reasoning fail? (wrong concept, missing knowledge, calculation error, skipped derivation step, incorrect application of principle)
2. **Cluster** -- Group failures by knowledge gap, not just topic label (e.g., "confuses Bell states with GHZ states" not just "quantum entanglement")
3. **Diagnose** -- Root cause per cluster (missing foundational knowledge, incorrect associations, calculation methodology gaps, reasoning chain breaks)
4. **Prioritize** -- Rank gaps by expected impact (which gaps, if filled, would improve the most benchmark questions)
5. **Avoid duplication** -- Do not re-target areas that improved in previous cycles. If a gap was targeted in a failed cycle, the agent should try a different approach to the same gap (different angle, deeper material, prerequisite knowledge).

#### History Pruning
- Rolling window of last `history_window` cycles (default: 5)
- Within the window: full cluster data, search queries, outcomes (pass/fail after targeting)
- Beyond the window: summary only (list of solved gaps and persistent gaps)

#### Outputs
- Structured failure metadata (JSON):
  - `clusters[]`: each with `gap_description`, `root_cause`, `affected_questions[]`, `priority_score`
  - `search_queries[]`: specific queries for paper retrieval per cluster
  - `generation_guidance`: instructions for the curation stage on what types of reasoning chains to generate

#### VRAM
- Load gpt-oss:120b via Ollama for agent reasoning
- Unload after tally completes (via Ollama API `keep_alive: 0`)

### [2] RETRIEVE -- Paper Retrieval

- **Sources:** Semantic Scholar API, arXiv API (existing infrastructure in `sdgs/scrape.py`)
- **Queries:** Driven by tally agent's `search_queries` output
- **Targeting:** Only retrieve papers relevant to diagnosed knowledge gaps
- **Volume:** Enough papers per cluster to support 1-2k+ total Q&A pairs
- **Output:** Full paper text (PDFs via PyMuPDF), metadata, abstracts
- **Fallback:** If no papers found for a cluster's queries, broaden search terms and retry. If still no results, skip that cluster and log a warning.
- **Min pairs enforcement:** If retrieved papers cannot support `min_pairs_per_cycle`, expand retrieval to related topics until minimum is met, or proceed with available papers and log a warning.
- **VRAM:** None required -- API calls only.

### [3] CURATE -- Grounded Chain-of-Thought Generation

- **Model:** gpt-oss:120b via Ollama (generation), lightweight models (verification)
- **Input:** Retrieved papers + tally agent's `generation_guidance`

#### Generation Process
1. Chunk each paper into sections (paragraphs / logical sections)
2. Embed all chunks using `all-MiniLM-L6-v2` (same model used by existing knowledge base)
3. For each knowledge gap, generate chain-of-thought reasoning pairs using gpt-oss:120b
4. Each response must include full derivation/reasoning trace, not just final answer
5. Format for training (instruction/response pairs in JSONL)

#### Three-Layer Verification Pipeline

Every generated pair passes through three verification checks before being accepted into the dataset. Lightweight models handle verification so gpt-oss:120b stays focused on generation.

**[A] Citation Matching**
- The generation prompt instructs gpt-oss:120b to include inline citations referencing paper sections (e.g., "[Paper: Title, Section 3.2]")
- Verify each citation: fuzzy-match the cited section identifier against the paper's actual section headings and content
- **Pass criteria:** All citations resolve to real content in the source papers
- **On failure:** Discard the pair, log "unresolvable citation"

**[B] Entailment Checking**
- Split the reasoning chain into individual claims/steps
- For each claim, run NLI against the relevant paper chunk(s) using `deberta-v3-base-mnli`
- NLI output: entailment / neutral / contradiction
- **Pass criteria:** No claim classified as "contradiction"; at least 50% of claims classified as "entailment" (remainder may be "neutral" for mathematical derivation steps not directly stated in text)
- **On failure:** Discard the pair, log which claims contradicted the source

**[C] Chunk Tracing**
- Split reasoning chain into steps
- For each step, compute embedding similarity (cosine) against all paper chunks using `all-MiniLM-L6-v2`
- Find the most similar chunk for each reasoning step
- **Pass criteria:** Each reasoning step has at least one chunk with similarity >= configurable threshold (default: 0.3). Low threshold because mathematical derivations may use different phrasing than the source paper.
- **On failure:** Discard the pair, log which steps had no grounding

#### Verification Outcome
- Pairs passing all three checks -> accepted into training dataset
- Pairs failing any check -> discarded with reason logged to `curation_rejects.jsonl`
- If accepted pairs fall below `min_pairs_per_cycle`, generate more pairs from the same papers and re-verify

#### Volume
- 1-2k verified Q&A pairs minimum per cycle, no upper cap
- **Output:** JSONL training dataset + dataset config YAML + `curation_rejects.jsonl` (for debugging)

#### VRAM
- gpt-oss:120b via Ollama for generation
- `all-MiniLM-L6-v2` (~80MB) for chunk embedding and chunk tracing -- stays loaded alongside generation model
- `deberta-v3-base-mnli` (~350MB) for NLI entailment checking -- stays loaded alongside generation model
- All three models unloaded after curation completes

### [4] TRAIN

- **Method:** LoRA fine-tuning (4-bit quantized base, nf4)
- **Base model:** The current merged model (starts as original 7-8B, improves each successful cycle)
- **Dataset:** Curated chain-of-thought reasoning pairs from CURATE stage (new data only, no mixing)
- **Parameters:** Current defaults (3 epochs, lr 1e-5, cosine scheduler, batch 4, grad accum 4)
- **Convergence:** Expected within 3 epochs given 1-2k focused samples
- **Invocation:** Direct call to `QwenTrainer` (no QFTL bridge, no web server)
- **Output:** LoRA adapter checkpoint
- **VRAM:** Load base model (4-bit) + LoRA. Unload after training completes.

### [5] MERGE

- Merge LoRA adapter into base model weights (`merge_and_unload()`)
- Save merged model in HF format to versioned path: `models/merged/base-v{N}/`
- Do NOT delete the merged model (gate may keep or rollback)
- GGUF conversion is optional (for deployment, not required by the loop)
- Direct call to `merge_lora()` from `merge_convert.py` (no bridge)
- **VRAM:** Load base model (FP16) + adapter for merge. Unload after save.

### [6] EVALUATE -- Benchmarks

Run four benchmark tasks via `lm-eval` (EleutherAI harness) against the merged model:

- **GPQA Diamond** -- PhD-level science reasoning (multiple choice)
- **MMLU college_physics** -- college-level physics (multiple choice)
- **MMLU conceptual_physics** -- conceptual physics (multiple choice)
- **SciBench** -- university-level calculation problems

The existing RAG-grounded judge (`evaluator.py`) is **disabled but preserved** in the codebase. It can be re-enabled later if needed.

#### lm-eval Invocation

```python
# Programmatic invocation via lm-eval Python API
from lm_eval import evaluator
from lm_eval.models.huggingface import HFLM

model = HFLM(pretrained="models/merged/base-v{N}/", batch_size=4)
results = evaluator.simple_evaluate(
    model=model,
    tasks=["gpqa_diamond", "mmlu_college_physics", "mmlu_conceptual_physics", "scibench"],
    log_samples=True,  # required: per-question data for tally agent
)
```

#### Per-Question Data Extraction

`lm-eval` with `log_samples=True` produces per-sample logs including:
- The prompt sent to the model
- The model's selected answer (for multiple choice: log-likelihoods over choices)
- The correct answer
- Whether the model was correct

These are extracted and structured into the format the tally agent expects:
```json
{
  "task": "gpqa_diamond",
  "question": "...",
  "model_answer": "B",
  "correct_answer": "C",
  "passed": false,
  "model_reasoning": "..."  // if available from generation tasks
}
```

For multiple-choice tasks (GPQA, MMLU), `lm-eval` uses log-likelihood scoring -- the model does not generate text. The tally agent receives which answer the model selected and which was correct, but not a reasoning trace. For SciBench (generation task), the model's full response is captured.

#### Output
- Per-question pass/fail with model answer and correct answer
- Aggregate scores per benchmark (percentage correct)
- Combined average across all four benchmark tasks (the gate metric)

#### VRAM
- Load the merged model for inference (HF format, quantization per lm-eval defaults)
- Unload after evaluation completes

### [7] GATE -- Quality Control

**Gate metric:** Simple average of all four benchmark scores.

```
gate_score = (gpqa_diamond + mmlu_college_physics + mmlu_conceptual_physics + scibench) / 4
```

**Merge threshold:** `gate_score` must improve by >= 0.5 percentage points over the previous checkpoint's gate score.

#### On improvement (>= 0.5pp):
1. Keep the merged model as the new base
2. Clean up old checkpoints (keep last 5 + original base)
3. Log success to `loop_log.jsonl`
4. Reset `consecutive_gate_failures` counter to 0
5. Proceed to TALLY with updated failure data

#### On regression or insufficient improvement:
1. Delete the merged model from this cycle
2. Roll back to the previous checkpoint (last successful merge, or original base if no merges yet)
3. Log failure to `loop_log.jsonl`
4. Increment `consecutive_gate_failures` counter
5. Proceed to TALLY -- agent re-diagnoses and generates a *different* dataset
6. Next cycle trains fresh LoRA on the rolled-back base

#### Fail cap:
After 3 consecutive failed quality gates on the same base model:
1. Tally agent performs deep diagnosis (expanded analysis prompt with full cycle history, not just rolling window)
2. Email analysis report to kylan.ml.ai@gmail.com
3. Pause loop -- wait for human intervention
4. `consecutive_gate_failures` resets when loop resumes with human guidance

---

## VRAM Sequencing

Models are loaded and unloaded sequentially. Only one large model occupies VRAM at a time. Ollama model unloading is triggered via the API with `keep_alive: 0`.

```
[0] BASELINE: Load 7-8B base model       -->  Unload (first run only)
[1] TALLY:    Load gpt-oss:120b          -->  (keep loaded for CURATE)
[2] RETRIEVE: No model needed (API calls)
[3] CURATE:   gpt-oss:120b (already loaded) -->  Unload
[4] TRAIN:    Load 7-8B (4-bit) + LoRA   -->  Unload
[5] MERGE:    Load 7-8B (FP16) + adapter  -->  Unload
[6] EVALUATE: Load merged model (HF)      -->  Unload
[7] GATE:     No model needed (numeric comparison)
              |
              v
[1] TALLY:    Load gpt-oss:120b          -->  ...
```

---

## Training Strategy: Merge-and-Continue

```
Baseline: Original base (7B) -> benchmark -> establish scores
Cycle 1:  Original base + LoRA -> train -> merge -> eval -> gate passes -> keep Base v1
Cycle 2:  Base v1 + fresh LoRA -> train -> merge -> eval -> gate passes -> keep Base v2
Cycle 3:  Base v2 + fresh LoRA -> train -> merge -> eval -> gate fails -> rollback to Base v2
Cycle 4:  Base v2 + fresh LoRA (different data) -> train -> merge -> eval -> gate passes -> keep Base v3
```

- Every cycle merges before eval (required by lm-eval)
- Gate decides whether to keep or rollback the merge
- Fresh LoRA initialized each cycle (no adapter stacking)
- Original base model preserved as ultimate rollback point
- Each successfully kept merge saved as a versioned checkpoint
- Checkpoint retention: last 5 successful merges + original base; older checkpoints deleted
- No dataset mixing -- merge-and-continue bakes knowledge into weights

---

## Checkpoint Management

Versioned checkpoints stored in `models/merged/`:
```
models/merged/
  base-v0/    # original base model (never deleted)
  base-v1/    # first successful merge
  base-v2/    # second successful merge
  ...
  base-v{N}/  # latest successful merge
```

**Retention policy:** Keep the last 5 successfully merged checkpoints plus the original base. When a 6th successful merge is saved, delete the oldest non-original checkpoint.

**Rollback:** On gate failure, the merged model from the failed cycle is deleted. The loop reverts to the most recent kept checkpoint.

---

## Termination Conditions

| Condition | Trigger | StopReason | Action |
|-----------|---------|------------|--------|
| Target reached | Average benchmark score >= target (default 85%) | `TARGET_REACHED` | Stop, report success |
| Fail cap | 3 consecutive failed quality gates | `FAIL_CAP` | Email report, pause for human |
| Max cycles | Configurable upper limit (default 50) | `MAX_CYCLES` | Stop, report final state |
| Manual stop | User request | `MANUAL_STOP` | Stop gracefully |

### StopReason Enum
```python
class StopReason(str, Enum):
    TARGET_REACHED = "target_reached"
    FAIL_CAP = "fail_cap"
    MAX_CYCLES = "max_cycles"
    MANUAL_STOP = "manual_stop"
    ABORTED = "aborted"  # unrecoverable error
```

---

## Resume Behavior

The loop is resumable from any stage. On crash or restart:

1. Read `state.py` for current cycle and stage
2. Resume from the interrupted stage:
   - **TALLYING/RETRIEVING/CURATING:** Re-run the stage from scratch (these are idempotent)
   - **TRAINING:** Resume from last checkpoint if available, otherwise restart training
   - **MERGING:** Re-run merge (idempotent -- overwrites same versioned path)
   - **EVALUATING:** Re-run benchmarks (idempotent)
   - **GATING:** Re-run gate decision (idempotent -- reads eval results)
3. If a merged model exists but GATE hasn't run, run GATE to decide keep/rollback

---

## Migration from Current 7-Stage Flow

The existing orchestrator uses 7 stages via QFTL bridge (HTTP calls to web server):
```
GENERATING -> FORMATTING -> TRANSFERRING -> TRAINING -> CONVERTING -> EVALUATING -> ANALYZING
```

The new flow has 8 stages, all running locally (no bridge, no web server):
```
BASELINE -> TALLYING -> RETRIEVING -> CURATING -> TRAINING -> MERGING -> EVALUATING -> GATING
```

### Stage Mapping

| Old Stage | New Stage | Notes |
|-----------|-----------|-------|
| GENERATING | CURATING | Now driven by tally agent metadata; produces chain-of-thought reasoning data |
| FORMATTING | Folded into CURATING | Curation outputs training-ready JSONL directly |
| TRANSFERRING | Removed | No bridge; dataset config written locally by CURATING |
| TRAINING | TRAINING | Direct `QwenTrainer` call; base model changes via merge-and-continue |
| CONVERTING | MERGING | Merge separated from GGUF conversion; merge happens every cycle |
| EVALUATING | EVALUATING | lm-eval benchmarks replace RAG judge; runs on merged HF model |
| ANALYZING | TALLYING + GATING | Split into tally agent (diagnosis) and quality gate (keep/rollback) |

### Removed Components

| Component | Reason |
|-----------|--------|
| `sdgs/loop/bridge.py` | No longer needed; all operations are local |

### State Schema Changes

The `Stage` enum in `state.py` must be updated:
```python
class Stage(str, Enum):
    BASELINE = "baseline"
    TALLYING = "tallying"
    RETRIEVING = "retrieving"
    CURATING = "curating"
    TRAINING = "training"
    MERGING = "merging"
    EVALUATING = "evaluating"
    GATING = "gating"
```

New fields in `cycle_records` (renamed from `evolution_records`):
- `merged_model_path` -- path to merged HF model (null if gate failed and model was deleted)
- `gate_passed` -- boolean (null for baseline)
- `gate_delta` -- score improvement in percentage points
- `consecutive_gate_failures` -- running count (resets on gate pass)
- `tally_metadata` -- JSON blob of tally agent output (clusters, queries, guidance)
- `benchmark_scores` -- JSON blob: `{"gpqa_diamond": N, "mmlu_college_physics": N, "mmlu_conceptual_physics": N, "scibench": N, "average": N}`

Removed fields (RAG judge specific):
- `factual_accuracy`, `completeness`, `technical_precision` -- replaced by `benchmark_scores`
- `domain_scores` -- replaced by per-benchmark breakdown
- `qftl_training_id`, `qftl_eval_id`, `qftl_convert_id` -- no bridge

---

## Architecture: What Changes

### New Components

| Component | Purpose |
|-----------|---------|
| `sdgs/loop/tally_agent.py` | LangChain ReAct agent for failure diagnosis (gpt-oss:120b via Ollama) |
| `sdgs/loop/quality_gate.py` | Keep/rollback decision logic with fail cap tracking and checkpoint cleanup |
| `sdgs/loop/benchmark_runner.py` | GPQA, MMLU, SciBench evaluation via lm-eval Python API |
| `sdgs/loop/email_reporter.py` | Email analysis reports on fail cap trigger (Gmail App Password auth) |
| `loop_log.jsonl` | Per-cycle log (appended each cycle) |
| `loop_projects.json` | Project-level tracking |

### Modified Components

| Component | Change |
|-----------|--------|
| `sdgs/loop/orchestrator.py` | Rewrite: new 8-stage flow, direct local calls (no bridge), merge-before-eval, rollback on failure, VRAM sequencing, checkpoint management |
| `sdgs/loop/config.py` | New config structure replacing QFTL-oriented config |
| `sdgs/loop/state.py` | New Stage/StopReason enums, cycle_records schema, removed bridge-related fields |
| `sdgs/web/engine/merge_convert.py` | Separate merge from GGUF conversion; merge preserves HF model; versioned output paths |

### Removed Components

| Component | Reason |
|-----------|--------|
| `sdgs/loop/bridge.py` | QFTL bridge eliminated; all operations local |
| `sdgs/loop/analyzer.py` | Replaced by tally agent |
| `sdgs/loop/formatter.py` | Folded into CURATE stage |

### Disabled Components

| Component | Status |
|-----------|--------|
| `sdgs/web/engine/evaluator.py` | RAG judge disabled, code preserved. Not called from loop. |

### Unchanged Components

| Component | Why |
|-----------|-----|
| `sdgs/web/engine/trainer.py` | Training mechanics stay the same; called directly instead of via bridge |
| `sdgs/scrape.py` | Paper retrieval infrastructure reused by RETRIEVE stage |

---

## Dependencies

### New
- `langchain` + `langchain-ollama` -- Agent orchestration for tally agent
- `lm-eval` (EleutherAI) -- Benchmark harness for GPQA, MMLU, SciBench
- `sentence-transformers` -- Embedding model for chunk tracing (`all-MiniLM-L6-v2`)

### Existing (no changes)
- `openai` SDK -- Ollama-compatible generation for curation
- `semanticscholar`, `arxiv` -- Paper retrieval
- `transformers`, `peft`, `bitsandbytes` -- Training, merge, and NLI (`deberta-v3-base-mnli`)
- `smtplib` (stdlib) -- Email reporting

---

## Configuration

```yaml
# Quality gate
gate:
  improvement_threshold: 0.5  # 0.5 percentage points minimum improvement to keep merge
  fail_cap: 3                 # consecutive failures before escalation
  alert_email: "kylan.ml.ai@gmail.com"
  smtp_host: "smtp.gmail.com"
  smtp_port: 587
  smtp_user: ""               # Gmail address for sending
  smtp_app_password: ""       # Gmail App Password (not regular password)

# Training strategy
training:
  strategy: "merge-and-continue"
  base_model: "Qwen/Qwen2.5-7B-Instruct"
  preserve_original: true
  model_config: "qwen2.5-7b-instruct"
  training_config: "default"
  checkpoint_dir: "models/merged/"
  max_checkpoints: 5           # keep last N + original

# Benchmarks
benchmarks:
  suites:
    - gpqa_diamond
    - mmlu_college_physics
    - mmlu_conceptual_physics
    - scibench
  batch_size: 4

# Tally agent
tally:
  model: "gpt-oss:120b"
  provider: "ollama"
  max_clusters: 10
  history_window: 5
  max_retries: 3               # retries on malformed output

# Curation
curation:
  model: "gpt-oss:120b"
  provider: "ollama"
  min_pairs_per_cycle: 1000
  max_pairs_per_cycle: -1      # no cap
  format: "chain-of-thought"   # reasoning trace in every response
  verification:
    citation_matching: true
    entailment_model: "microsoft/deberta-v3-base-mnli"
    entailment_min_ratio: 0.5     # at least 50% of claims must be "entailment"
    embedding_model: "all-MiniLM-L6-v2"
    chunk_similarity_threshold: 0.3
    rejects_log: "curation_rejects.jsonl"

# Retrieval
retrieval:
  sources:
    - semantic_scholar
    - arxiv
  max_papers_per_cluster: 10

# Logging
logging:
  cycle_log: "loop_log.jsonl"
  project_log: "loop_projects.json"
  log_dir: "logs/loop/"        # base directory for all loop logs

# Termination
termination:
  target_score: 85.0
  max_cycles: 50
```

---

## Data Flow Example (Full Run)

```
BASELINE: Benchmark unmodified Qwen2.5-7B-Instruct
  GPQA Diamond: 28%
  MMLU college_physics: 55%
  MMLU conceptual_physics: 52%
  SciBench: 34%
  Average: (28 + 55 + 52 + 34) / 4 = 42.25%
  -> Log as cycle 0                            VRAM: 7-8B -> unload

CYCLE 1:
  TALLY: Analyze 58% failed questions          VRAM: gpt-oss:120b
    Cluster 1: "Basic quantum mechanics
      -- model skips operator algebra steps" (HIGH)
    Cluster 2: "Classical mechanics
      -- reasoning chain breaks at Lagrangian formulation" (HIGH)
    Cluster 3: "Thermodynamics
      -- confuses intensive/extensive properties" (MEDIUM)
  RETRIEVE: 30 papers                          VRAM: none
  CURATE: 1.5k chain-of-thought pairs          VRAM: gpt-oss:120b -> unload
  TRAIN: LoRA on base, 3 epochs                VRAM: 7-8B (4-bit) -> unload
  MERGE: Merge adapter into base               VRAM: 7-8B (FP16) -> unload
  EVALUATE: Benchmark merged model             VRAM: merged model -> unload
    GPQA: 35%, MMLU_college: 63%, MMLU_conceptual: 60%, SciBench: 45%
    Average: (35 + 63 + 60 + 45) / 4 = 50.75% (prev: 42.25%)
  GATE: +8.5pp >= 0.5pp -> KEEP
    Save as Base v1, cleanup old checkpoints
  -> Log cycle 1

CYCLE 2:
  TALLY: Analyze remaining failures            VRAM: gpt-oss:120b
    Cluster 1: "Quantum entanglement
      -- model applies Bell inequality incorrectly" (HIGH)
    Cluster 2: "Perturbation theory
      -- missing second-order correction derivation" (HIGH)
  RETRIEVE: 20 papers                          VRAM: none
  CURATE: 1.2k chain-of-thought pairs          VRAM: gpt-oss:120b -> unload
  TRAIN: LoRA on Base v1, 3 epochs             VRAM: 7-8B (4-bit) -> unload
  MERGE: Merge adapter into Base v1            VRAM: 7-8B (FP16) -> unload
  EVALUATE: Benchmark merged model             VRAM: merged model -> unload
    GPQA: 36%, MMLU_college: 63%, MMLU_conceptual: 60%, SciBench: 44%
    Average: (36 + 63 + 60 + 44) / 4 = 50.75% (prev: 50.75%)
  GATE: +0.0pp < 0.5pp -> ROLLBACK
    Delete merged model, revert to Base v1
    consecutive_gate_failures: 1
  -> Log cycle 2 (gate_passed: false)

CYCLE 3:
  TALLY: Re-diagnose with different approach   VRAM: gpt-oss:120b
    (sees cycle 2 failed targeting entanglement/perturbation;
     tries prerequisite knowledge: linear algebra foundations,
     Hilbert space formalism)
  ...continues...
```
