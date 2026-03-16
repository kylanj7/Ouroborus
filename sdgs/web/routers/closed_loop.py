"""REST and SSE endpoints for the closed-loop training system."""
from __future__ import annotations

import asyncio
import json
import queue
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..deps import CurrentUser, get_current_user
from ..services.closed_loop_service import (
    get_active_loop_id,
    get_cl_logs,
    get_cl_queue,
    start_closed_loop,
    stop_closed_loop,
)
from ...loop.state_v2 import LoopStateStore

router = APIRouter(prefix="/api/closed-loop", tags=["closed-loop"])

_state_store = LoopStateStore()

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}

_EMPTY_SENTINEL = object()


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------

class ClosedLoopStartRequest(BaseModel):
    config_path: str | None = None


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

async def _await_queue_item(q: queue.Queue, timeout: float = 1.0):
    """Block on a stdlib queue.Queue without busy-waiting by offloading to a thread."""
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, q.get, True, timeout)
    except queue.Empty:
        return _EMPTY_SENTINEL


def _cycle_to_dict(record) -> dict[str, Any]:
    return {
        "cycle": record.cycle,
        "benchmark_scores": record.benchmark_scores,
        "gate_passed": record.gate_passed,
        "gate_delta": record.gate_delta,
        "consecutive_gate_failures": record.consecutive_gate_failures,
        "merged_model_path": record.merged_model_path,
        "tally_metadata": record.tally_metadata,
        "dataset_path": record.dataset_path,
        "dataset_size": record.dataset_size,
        "adapter_path": record.adapter_path,
        "training_loss": record.training_loss,
        "started_at": record.started_at,
        "completed_at": record.completed_at,
    }


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.post("/start")
async def start_loop(
    req: ClosedLoopStartRequest,
    current_user: CurrentUser = Depends(get_current_user),
):
    """Start a new closed-loop training run."""
    try:
        loop_id = start_closed_loop(config_path=req.config_path)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"loop_id": loop_id, "status": "running"}


@router.post("/stop")
async def stop_loop(
    current_user: CurrentUser = Depends(get_current_user),
):
    """Request a graceful stop of the active closed-loop run."""
    loop_id = get_active_loop_id()
    if loop_id is None:
        raise HTTPException(status_code=404, detail="No active closed-loop run")
    stop_closed_loop()
    return {"loop_id": loop_id, "status": "stop_requested"}


@router.get("/status")
async def get_status():
    """Get the current closed-loop status."""
    loop_id = get_active_loop_id()
    if loop_id is None:
        return {"loop_id": None, "status": "idle", "current_cycle": 0, "current_stage": None}
    state = _state_store.get_loop(loop_id)
    if state is None:
        return {"loop_id": None, "status": "idle", "current_cycle": 0, "current_stage": None}
    return {
        "loop_id": state.loop_id,
        "status": state.status,
        "current_cycle": state.current_cycle,
        "current_stage": state.current_stage,
        "stop_reason": state.stop_reason,
        "stop_requested": state.stop_requested,
        "created_at": state.created_at,
        "updated_at": state.updated_at,
    }


@router.get("/history")
async def get_history(loop_id: str | None = Query(None)):
    """Return cycle history for a closed-loop run."""
    resolved_id = loop_id or get_active_loop_id()
    if resolved_id is None:
        return {"loop_id": None, "cycles": []}
    state = _state_store.get_loop(resolved_id)
    if state is None:
        return {"loop_id": None, "cycles": []}
    return {
        "loop_id": state.loop_id,
        "cycles": [_cycle_to_dict(r) for r in state.cycles],
    }


@router.get("/events")
async def closed_loop_events(last_id: int = Query(-1)):
    """SSE stream for a closed-loop training run."""
    loop_id = get_active_loop_id()

    async def event_generator():
        stored = get_cl_logs(loop_id) if loop_id else []
        event_id = len(stored)

        for i, item in enumerate(stored):
            if i <= last_id:
                continue
            yield f"id: {i}\ndata: {json.dumps(item)}\n\n"

        if loop_id is None:
            yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
            return

        q = get_cl_queue(loop_id)
        if q is None:
            yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
            return

        while True:
            try:
                item = await _await_queue_item(q)
                if item is _EMPTY_SENTINEL:
                    yield f": keepalive\n\n"
                    continue
                if item is None:
                    yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
                    return
                yield f"id: {event_id}\ndata: {json.dumps(item)}\n\n"
                event_id += 1
            except asyncio.CancelledError:
                return

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=_SSE_HEADERS)
