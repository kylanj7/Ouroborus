# Agent Management Team -- Design Spec

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Deploy an external agent team to observe, fix, and complete 2 full cycles of the Ouroboros Evolution Loop.

---

## Overview

The system deploys three cooperating agents -- Watcher, Fixer, Auditor -- as an external SSE consumer that monitors and manages the existing closed-loop training pipeline. The agents interact with the loop exclusively through the REST API and SSE stream, preserving the existing subprocess isolation and VRAM management.

### Deliverables

| File | Purpose |
|---|---|
| `sdgs/agents/__init__.py` | Package init |
| `sdgs/agents/cli.py` | CLI entry point (`python -m sdgs.agents`) |
| `sdgs/agents/orchestrator.py` | Watcher: SSE consumer, event dispatch, restart logic |
| `sdgs/agents/fixer.py` | Markdown-to-JSON sanitizer + training error branch + config adjuster |
| `sdgs/agents/auditor.py` | Score tracker + `evolution_progress.md` writer |
| `evolution_progress.md` | Live-updated run log (generated at project root) |

### Existing Code Changes

| File | Change |
|---|---|
| `sdgs/loop/orchestrator_v2.py` | Add `resume_from` parameter to `run()` |
| `sdgs/web/routers/closed_loop.py` | Add `resume_from`, `resume_loop_id` to start request |
| `sdgs/web/services/closed_loop_service.py` | Pass resume fields through to subprocess |

---

## Section 1: Orchestrator Resume Patch

### `orchestrator_v2.py` -- `resume_from` Parameter

`run()` gains an optional `resume_from: Stage | None` parameter. When set:

- BASELINE is skipped (scores already exist in state DB)
- The orchestrator loads the existing `CycleRecord` for the current cycle from SQLite to recover `tally_metadata`, `dataset_path`, etc.
- Stages before `resume_from` are skipped on cycle 1 only
- Gate logic: `Execute Stage S <=> S >= resume_from OR Cycle > 1`
- After the first cycle completes, `resume_from` is cleared and subsequent cycles run the full stage order

Stage order used for comparison:

```python
STAGE_ORDER = [
    Stage.TALLYING, Stage.RETRIEVING, Stage.CURATING,
    Stage.TRAINING, Stage.MERGING, Stage.EVALUATING, Stage.GATING
]
```

### REST API Changes

`ClosedLoopStartRequest` gains two optional fields:

```python
resume_from: str | None = None      # Stage name, e.g. "retrieving"
resume_loop_id: str | None = None   # Reuse existing loop_id
```

Validation: if `resume_from` is provided, the service verifies `resume_loop_id` exists in SQLite before booting the subprocess. Returns 404 if not found.

`start_closed_loop()` passes both fields through to `_run_loop_subprocess()`, which passes them to `orchestrator.run()`.

---

## Section 2: The Fixer -- `sdgs/agents/fixer.py`

### 2a: Markdown-to-JSON Sanitizer

`sanitize_tally_output(raw: str) -> dict | None`

Multi-strategy parser, tried in order:

| Strategy | Method |
|---|---|
| 1 | Direct `json.loads(raw)` |
| 2 | Extract from triple-backtick fences (` ```json ... ``` `) |
| 3 | Find outermost JSON object braces `{...}`, extract and parse |
| 4 | Markdown table-to-JSON converter: regex-match table rows, map columns to schema fields, build clusters array, synthesize search_queries from gap_description text |
| 5 | Return `None` (caller falls back to `fallback_analysis()`) |

All strategies validate against the expected schema:
- Must have `clusters` (list, len > 0), `search_queries` (list, len > 0), `generation_guidance` (str)
- Strategy 4 includes a reasonability check: 0 clusters or 0 search queries counts as failure

### Fixer Flow for Tally Failures

1. Watcher detects log event containing `"fallback"` or JSON parse failure keywords during TALLY stage
2. Fixer pulls raw LLM response from `logs/loop/{loop_id}.log` (tally agent logs first 1500 chars on failure)
3. Fixer runs `sanitize_tally_output(raw)`
4. Success: write corrected `tally_metadata` into SQLite `cycle_records` table, then `POST /stop` followed by `POST /start` with `resume_from=retrieving` and `resume_loop_id`
5. Failure: let `fallback_analysis()` stand, continue cycle normally (degraded)

### 2b: Training Error Branch

When the Watcher detects a TRAINING stage failure, the Fixer:

1. Reads the `.error` file from the checkpoint directory (`models/merged/`)
2. Pattern-matches the traceback:

| Pattern | Action |
|---|---|
| `CUDA out of memory` / `OutOfMemoryError` | Halve `batch_size`, double `grad_accumulation_steps`. Effective batch unchanged. |
| `Loss is NaN` / `Loss is Inf` | Enable `max_grad_norm: 1.0`, reduce `learning_rate` by 50%. |
| `PicklingError` / `AttributeError` / `Can't pickle` | **STOP.** Log as "Code Regression". No retry. |
| `TimeoutError` / `DataLoader worker` | Double `dataloader_timeout`. Keep hardware params. |
| `CUDA error: illegal memory access` / `device-side assert` | **STOP.** Trigger `cleanup_gpu()`. Log as "Hardware Fault". |

3. If action is config adjustment: modify `configs/closed_loop.yaml`, restart with `resume_from=training` and same `resume_loop_id`
4. Maximum 3 retry attempts per cycle

### Config State Lock

The Fixer tracks a `set[frozenset]` of already-failed config combinations per cycle. Before applying an adjustment, it checks whether the resulting config has already been tried. If so, it stops rather than oscillating between failing configurations.

### Before/After Logging

Every config adjustment is logged to `evolution_progress.md` with old and new values, e.g.:
```
- Config Adjustment: batch_size 32->16, grad_accumulation_steps 4->8
  Reason: CUDA out of memory in _train_worker
```

---

## Section 3: The Watcher -- `sdgs/agents/orchestrator.py`

### Lifecycle

```
CLI entry (python -m sdgs.agents)
    |
    v
Boot: start `sdgs serve` as managed subprocess (if not already running)
    |
    v
Wait for server health (GET /api/closed-loop/status returns 200)
    |
    v
Start loop: POST /api/closed-loop/start with production config
    |
    v
SSE Subscribe: GET /api/closed-loop/events (async stream via httpx)
    |
    v
Event Loop (dispatch per event type):
    type=stage   --> Auditor.on_stage()
    type=log     --> Pattern scan for tally failure or training metrics
    type=error   --> Fixer.handle_error()
    type=status  --> "completed": finalize and exit
                     "failed": Fixer.handle_crash(), restart or exit
    type=done    --> Stream ended, check /status
```

### SSE Reconnection

Tracks `last_id` from each event. On stream drop, reconnects with `?last_id=N` to replay missed events (server already supports this).

### State Tracking

```python
@dataclass
class WatcherState:
    loop_id: str | None = None
    current_stage: str | None = None
    current_cycle: int = 0
    retry_count: int = 0              # per-stage, reset on stage advance
    max_retries: int = 3
    failed_configs: set = field(default_factory=set)  # Config State Lock
    target_cycles: int = 2            # stop after 2 GATE-passed cycles
    completed_cycles: int = 0         # cycles that passed GATE
```

When `completed_cycles == target_cycles`, Watcher sends `POST /stop` and Auditor writes final report.

### Server Management

- Starts `sdgs serve` only if port 8000 is not already in use
- On exit, does NOT kill the server (shared resource)

---

## Section 4: The Auditor -- `sdgs/agents/auditor.py`

### Data Model

```python
@dataclass
class CycleSnapshot:
    cycle: int
    scores: dict[str, float] | None = None
    gate_passed: bool | None = None
    gate_delta: float = 0.0
    dataset_size: int = 0
    training_loss: float | None = None
    config_adjustments: list[dict] = field(default_factory=list)
    pain_points: list[str] = field(default_factory=list)
    tally_sanitized: bool = False
    started_at: str = ""
    completed_at: str = ""

@dataclass
class EvolutionRecord:
    baseline_scores: dict[str, float]
    baseline_average: float = 70.9
    target: float = 85.0
    cycles: list[CycleSnapshot] = field(default_factory=list)
    vram_events: list[str] = field(default_factory=list)
    total_fixer_interventions: int = 0
```

### Callbacks

| Method | Trigger | Action |
|---|---|---|
| `on_stage(stage, cycle)` | SSE `type=stage` | Log transition. Create new `CycleSnapshot` on cycle advance. |
| `on_training_log(line)` | SSE `type=log` during TRAINING | Extract loss values. |
| `on_gate_result(loop_id)` | GATING stage completes | Pull cycle record from `GET /history`. Compare to baseline. |
| `on_fixer_intervention(action, details)` | Called by Fixer after any fix | Record config adjustment or pain point. |
| `on_vram_event(event_text)` | SSE log matching `unload`/`loaded`/`cleanup` | Append to VRAM trace. |
| `finalize()` | Loop ends | Write final summary. |

### Output Format

`evolution_progress.md` at project root. Full rewrite on every significant event (not append). Contains:

- Run info (loop ID, timestamps, target vs baseline)
- Baseline scores table
- Per-cycle sections (scores, gate result, delta, dataset size, loss, pain points, config adjustments)
- VRAM trace (timestamped load/unload events)
- Summary (cycles completed, final average, fixer interventions, status)

---

## Section 5: CLI Entry Point -- `sdgs/agents/cli.py`

### Usage

```
python -m sdgs.agents [--cycles 2] [--config configs/closed_loop.yaml] [--no-serve]
```

| Flag | Default | Purpose |
|---|---|---|
| `--cycles` | `2` | Successful GATE-passed cycles before stopping |
| `--config` | `configs/closed_loop.yaml` | Path to loop config |
| `--no-serve` | `False` | Skip booting `sdgs serve` |

### `main()` Flow

1. Parse args
2. If not `--no-serve`: start `sdgs serve`, wait for health check on port 8000
3. Instantiate `Fixer`, `Auditor`, `WatcherState`
4. `POST /api/closed-loop/start` with config
5. Enter async SSE event loop
6. On exit: `Auditor.finalize()`, print path to `evolution_progress.md`

Runs in foreground. No daemon mode. Exits on target cycle count or unrecoverable error.

---

## Hardware Context

- 3x RTX 3090 (24 GB each, 72 GB total)
- Ollama `gpt-oss:120b` occupies ~65 GB across all 3 GPUs
- HF training (Qwen3.5-9B + LoRA) needs GPUs clear of Ollama
- All agent code runs CPU-only; never imports torch or CUDA
- TRAIN and MERGE always run in `spawn` subprocesses via the existing orchestrator

## Constraints

- Agent wrapper is an external observer -- never runs GPU workloads
- Resume logic lives inside the orchestrator, not the wrapper
- Maximum 3 config adjustment retries per cycle per stage
- Config State Lock prevents oscillation between failing configs
- PicklingError and CUDA illegal memory access are hard stops (no retry)
