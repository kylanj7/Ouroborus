# Evolution Loop UI Overhaul -- Design Spec

## Goal

Replace the existing Evolution Loop page with a new interface reflecting the 8-stage closed-loop training system. Same route, same sidebar entry, same "Evolution Loop" name. New backend API endpoints talk directly to the closed-loop orchestrator. The old evolution loop code is preserved but disconnected.

---

## Page Layout

The Loop page has 6 fixed sections (top to bottom) plus a floating gate banner overlay:

### 1. Controls Bar

Top of the page. Horizontal bar with:
- **Start button** with config selector dropdown (lists available YAML configs from `configs/closed_loop*.yaml`)
- **Stop button** (visible when running, calls `/api/closed-loop/stop`)
- **Status badge**: Running (blue pulse), Stopped (gray), Target Reached (green), Fail Cap (yellow -- shown when `stop_reason == "fail_cap"`)
- **Current base model version**: e.g., "Base v3" -- derived by counting `gate_passed == true` cycles in history
- **Fail counter**: "Gate failures: 1/3" (visible when `consecutive_gate_failures > 0`)

Note: there is no "paused" state. When fail cap is reached, the orchestrator stops the loop (`status == "stopped"`, `stop_reason == "fail_cap"`). The UI shows this as "Fail Cap" status badge in yellow.

### 2. Stage Pipeline

Horizontal strip showing the stages of the current cycle:

```
TALLY -> RETRIEVE -> CURATE -> TRAIN -> MERGE -> EVALUATE -> GATE
```

On cycle 0 (baseline), the pipeline shows a single "BASELINE" badge instead.

**Stage name mapping** (wire values from `state_v2.Stage` enum -> display labels):

| Wire Value (Stage enum) | Display Label |
|--------------------------|---------------|
| `baseline` | BASELINE |
| `tallying` | TALLY |
| `retrieving` | RETRIEVE |
| `curating` | CURATE |
| `training` | TRAIN |
| `merging` | MERGE |
| `evaluating` | EVALUATE |
| `gating` | GATE |

- Active stage: blue background with pulse animation
- Completed stages: green background with check icon
- Upcoming stages: gray background
- Current cycle number displayed above: "Cycle 3"

### 3. Benchmark Scores Chart

Main visual element. Recharts LineChart:

- **Lines derived dynamically** from the keys in `benchmark_scores` (excluding "average"). For the default config this produces 4 lines + average. If someone runs with different suites, the chart adapts.
- **Average line**: bold/dashed, always present
- **X-axis**: Cycle number (0 = baseline)
- **Y-axis**: Score percentage (0-100)
- **Reference line**: Horizontal dashed line at target score (from config, default 85%)
- **Gate markers**: Green circle on x-axis for gate pass, red X for gate fail
- **Tooltip**: Shows all scores + gate result on hover
- Colors: use existing CSS variable palette

### 4. Tally Agent Diagnosis

Full detail section, updates after each TALLY stage completes via SSE:

- **Header**: "Tally Diagnosis -- Cycle N" with cluster count and paper count
- **Per cluster** (card layout):
  - Gap description (bold title)
  - Root cause (italic text)
  - Priority score (horizontal bar, 0.0-1.0)
  - Affected questions (scrollable list, show question text truncated to 100 chars)
  - Search queries the tally agent generated for paper retrieval on this cluster
- **Papers retrieved**: count per cluster, total count
- **Generation guidance**: full text block

When no tally has run yet (cycle 0 / baseline), show "Tally diagnosis will appear after the first evaluation."

### 5. Quality Gate Banner (floating overlay)

This is NOT a fixed page section -- it is a floating notification that overlays the page when a gate decision is made. Appears below the controls bar, above the pipeline. Auto-dismisses after 10 seconds.

- **Pass**: Green banner -- "GATE PASSED +3.4pp -- merged as Base v4"
- **Fail**: Red banner -- "GATE FAILED -0.2pp -- rolled back to Base v3 (failure 2/3)"
- **Fail cap**: Yellow banner -- "FAIL CAP REACHED -- loop stopped, analysis emailed to operator"

Implemented as an absolutely positioned element with slide-in animation.

### 6. Cycle History Table

Scrollable table, one row per completed cycle:

| Column | Content | Source Field |
|--------|---------|--------------|
| Cycle | Cycle number (0 = "Baseline") | `cycle` |
| Base | Model version (v0, v1, ...) | Derived: v0 for baseline, increments on each `gate_passed == true` |
| Dataset | Size (e.g., "1,247 pairs") | `dataset_size` |
| Loss | Training loss (e.g., "0.42") | `training_loss` |
| Benchmark scores | One column per benchmark key | `benchmark_scores` (dynamic keys) |
| Average | Score % (bold) | `benchmark_scores.average` |
| Gate | Pass/fail badge with delta | `gate_passed` + `gate_delta` |
| Gaps | Number of clusters targeted | `len(tally_metadata.clusters)` |

Cycle 0 row: Dataset, Loss, Gate, Gaps columns show "--" (no training on baseline).

### 7. Live Logs

Collapsible section at the bottom (collapsed by default):
- Streaming text logs from SSE
- Color-coded by stage (each stage gets a prefix tag using the display label)
- Max 2000 lines (existing pattern from useLoopSSE)
- Auto-scroll to bottom when open

---

## Backend API

### New Router: `sdgs/web/routers/closed_loop.py`

Registered on the FastAPI app at `/api/closed-loop/`. All endpoints that modify state require authentication (`current_user = Depends(get_current_user)`).

#### `POST /api/closed-loop/start`

**Auth required.** Checks for already-running loop first -- returns HTTP 409 if one exists.

Request body:
```json
{
  "config_path": "configs/closed_loop.yaml"
}
```

If `config_path` is omitted, defaults to `configs/closed_loop.yaml`. Returns HTTP 400 if config file does not exist or is malformed.

Response:
```json
{
  "loop_id": "cl-a1b2c3d4",
  "status": "running"
}
```

The `loop_id` is generated by the service layer with a `"cl-"` prefix + `uuid4().hex[:8]`. This is passed to `ClosedLoopOrchestrator.run(loop_id=loop_id)`.

Launches the orchestrator in a background thread. Broadcasts progress via SSE.

#### `POST /api/closed-loop/stop`

**Auth required.** No body. The service layer calls `LoopStateStore.get_active_loop()` to find the running loop, then calls `request_stop(loop_id)`. Returns HTTP 404 if no active loop.

Response:
```json
{
  "loop_id": "cl-a1b2c3d4",
  "status": "stop_requested"
}
```

#### `GET /api/closed-loop/status`

Response:
```json
{
  "loop_id": "cl-a1b2c3d4",
  "status": "running",
  "current_cycle": 3,
  "current_stage": "training",
  "consecutive_gate_failures": 0,
  "stop_reason": null
}
```

`base_model_version` is NOT a stored field. The frontend derives it by counting `gate_passed == true` cycles from history. This keeps the API aligned with what `LoopStateStore` actually stores.

Returns `{"loop_id": null, ...}` if no loop has ever run.

#### `GET /api/closed-loop/history`

Query params: `loop_id` (optional, defaults to latest/active loop)

Response -- serializes `CycleRecord` fields directly:
```json
{
  "loop_id": "cl-a1b2c3d4",
  "cycles": [
    {
      "cycle": 0,
      "benchmark_scores": {"gpqa_diamond": 28.0, "mmlu_college_physics": 55.0, "mmlu_conceptual_physics": 52.0, "scibench": 34.0, "average": 42.25},
      "gate_passed": null,
      "gate_delta": 0.0,
      "consecutive_gate_failures": 0,
      "dataset_size": 0,
      "training_loss": null,
      "merged_model_path": null,
      "tally_metadata": {},
      "dataset_path": null,
      "adapter_path": null,
      "started_at": "2026-03-15T10:00:00Z",
      "completed_at": "2026-03-15T10:05:00Z"
    }
  ]
}
```

All `CycleRecord` fields are serialized. The frontend picks what it needs for display.

#### `GET /api/closed-loop/events` (SSE)

Uses the existing SSE infrastructure pattern from `sdgs/web/services/job_runner.py`. The service layer creates a broadcast queue and emits events as the orchestrator progresses. The SSE endpoint streams from this queue.

Event types:

| Event Type | Data | When |
|------------|------|------|
| `stage` | `{"cycle": 3, "stage": "training"}` | Stage transition (wire value from Stage enum) |
| `log` | `{"message": "Training epoch 2/3...", "stage": "training"}` | Any log output |
| `benchmark_scores` | `{"cycle": 3, "scores": {"gpqa_diamond": 38.0, ...}}` | After EVALUATE |
| `tally_result` | `{"cycle": 3, "clusters": [...], "search_queries": [...], "generation_guidance": "..."}` | After TALLY |
| `gate_decision` | `{"cycle": 3, "passed": true, "delta": 3.4, "consecutive_failures": 0}` | After GATE |
| `done` | `{"loop_id": "...", "stop_reason": "target_reached"}` | Loop finished |

Each event includes an incrementing `id` field for SSE reconnection (last-event-id). On reconnect, the client can resume from the last received event.

### New Service: `sdgs/web/services/closed_loop_service.py`

Thin wrapper that:
1. Creates a `ClosedLoopOrchestrator` instance with a `"cl-"` prefixed loop_id
2. Runs `orchestrator.run()` in a background thread
3. Hooks into the orchestrator by injecting a logging handler that captures log records and broadcasts them as SSE events
4. After each stage transition (detected by reading `LoopStateStore.get_loop()` on a polling interval or via callback), emits `stage` events
5. Exposes status/history by delegating to `LoopStateStore`
6. Emits `benchmark_scores`, `tally_result`, and `gate_decision` events by reading the `CycleRecord` after each relevant stage completes

**SSE broadcasting mechanism:** Uses the same `BroadcastQueue` pattern from `job_runner.py`. The service registers a broadcast type and enqueues events. The SSE endpoint dequeues and streams them.

### App Registration

Add to `sdgs/web/app.py`:
```python
from sdgs.web.routers.closed_loop import router as closed_loop_router
app.include_router(closed_loop_router)
```

---

## Frontend

### Modified Files

| File | Change |
|------|--------|
| `src/pages/Loop.tsx` | Complete rewrite -- new layout with 6 sections + gate banner overlay |
| `src/store/loopStore.ts` | New state: `cycles: CycleRecord[]`, `currentStage: string`, `currentCycle: number`, `status: string`, `stopReason: string | null`, `consecutiveGateFailures: number`, `tallyResult: TallyMetadata | null`, `gateBanner: GateBannerData | null`. New actions: `fetchStatus()`, `fetchHistory()`, `startLoop(configPath)`, `stopLoop()`, `addBenchmarkScores()`, `setTallyResult()`, `setGateDecision()`, `showGateBanner()`, `dismissGateBanner()` |
| `src/hooks/useLoopSSE.ts` | New event types: `benchmark_scores`, `tally_result`, `gate_decision`. Updated message parsing. Connects to `/api/closed-loop/events` |
| `src/api.ts` | New functions: `startClosedLoop(configPath)`, `stopClosedLoop()`, `getClosedLoopStatus()`, `getClosedLoopHistory(loopId?)`, `createClosedLoopSSE()` |

### New Files

| File | Purpose |
|------|---------|
| `src/components/loop/StagePipeline.tsx` | Horizontal stage strip with active/complete/upcoming states. Maps wire values to display labels. |
| `src/components/loop/BenchmarkChart.tsx` | Recharts LineChart with dynamic lines from benchmark_scores keys, target reference line, gate markers |
| `src/components/loop/TallyDiagnosis.tsx` | Cluster cards with gap details, priority bars, affected questions list, search queries |
| `src/components/loop/GateBanner.tsx` | Floating timed slide-in notification for gate pass/fail/cap. Auto-dismisses after 10s. |
| `src/components/loop/CycleHistory.tsx` | Table with per-cycle metrics and gate badges. Dynamic benchmark columns. |

### Styling

Follow existing patterns:
- CSS variables from `global.css` / `variables.css`
- Inline style objects (existing pattern throughout the app)
- Glassmorphism cards (existing pattern)
- Lucide React icons
- Recharts with existing color palette

---

## SSE Integration

The frontend connects to `/api/closed-loop/events` when the Loop page mounts via `createClosedLoopSSE()` in `api.ts`. Uses the existing `createSSEWithBackoff` pattern from `sse.ts` adapted for the new endpoint (no per-loop-id URL since the SSE streams the active loop).

The `useLoopSSE` hook handles new event types:

```typescript
case 'stage':
  store.setCurrentStage(data.stage)
  store.setCurrentCycle(data.cycle)
  break
case 'benchmark_scores':
  store.addBenchmarkScores(data.cycle, data.scores)
  break
case 'tally_result':
  store.setTallyResult(data.cycle, data)
  break
case 'gate_decision':
  store.setGateDecision(data.cycle, data)
  store.showGateBanner(data)
  break
case 'done':
  store.fetchStatus()
  store.fetchHistory()
  break
```

Reconnection uses existing exponential backoff. The `last-event-id` header allows the server to replay missed events on reconnect.

---

## What Changes

### New Backend Files

| File | Purpose |
|------|---------|
| `sdgs/web/routers/closed_loop.py` | FastAPI router with start/stop/status/history/events endpoints. Auth on mutating endpoints. 409 on concurrent loop start. |
| `sdgs/web/services/closed_loop_service.py` | Background orchestrator execution with SSE broadcasting via BroadcastQueue |

### New Frontend Files

| File | Purpose |
|------|---------|
| `src/components/loop/StagePipeline.tsx` | Stage visualization strip |
| `src/components/loop/BenchmarkChart.tsx` | Multi-line score chart |
| `src/components/loop/TallyDiagnosis.tsx` | Cluster detail cards |
| `src/components/loop/GateBanner.tsx` | Gate decision notification |
| `src/components/loop/CycleHistory.tsx` | Cycle metrics table |

### Modified Files

| File | Change |
|------|--------|
| `sdgs/web/app.py` | Register closed_loop router |
| `src/pages/Loop.tsx` | Complete rewrite |
| `src/store/loopStore.ts` | New state shape and API calls |
| `src/hooks/useLoopSSE.ts` | New event types |
| `src/api.ts` | New endpoint functions |

### Preserved (not deleted)

| File | Status |
|------|--------|
| `sdgs/web/routers/loop.py` | Old loop router -- preserved, still responds to old `/api/loop/*` endpoints but frontend no longer calls them |
| `sdgs/loop/orchestrator.py` | Old orchestrator -- preserved, not imported by new code |
| `sdgs/loop/bridge.py` | Old QFTL bridge -- preserved, not imported |
