"""REST endpoints for managing the evolution loop."""
from __future__ import annotations

import glob as globmod
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ...loop.config import load_loop_config
from ...loop.orchestrator import Orchestrator
from ...loop.state import StateStore
from ..services.job_runner import init_loop_stream, emit_loop_event, finish_loop_stream

router = APIRouter()

_store = StateStore()
_running_threads: dict[str, threading.Thread] = {}
_BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent


# ------------------------------------------------------------------
# Schemas
# ------------------------------------------------------------------

class LoopStartRequest(BaseModel):
    config_path: str | None = None


class EvolutionSummary(BaseModel):
    evolution: int
    overall_score: float
    factual_accuracy: float
    completeness: float
    technical_precision: float
    best_score_so_far: float
    delta_from_previous: float
    consecutive_regressions: int
    consecutive_plateaus: int
    target_reached: bool
    domain_scores: dict[str, Any]
    started_at: str | None
    completed_at: str | None


class LoopStatusResponse(BaseModel):
    loop_id: str
    status: str
    current_evolution: int
    current_stage: str
    stop_reason: str | None
    stop_requested: bool
    created_at: str
    updated_at: str
    evolutions: list[EvolutionSummary]
    config_snapshot: dict[str, Any]


class LoopListEntry(BaseModel):
    loop_id: str
    status: str
    current_evolution: int
    current_stage: str
    stop_reason: str | None
    created_at: str
    updated_at: str


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.post("/start")
async def start_loop(req: LoopStartRequest):
    """Start a new evolution loop in a background thread."""
    active = _store.get_active_loop()
    if active:
        raise HTTPException(status_code=409, detail=f"Loop {active.loop_id} is already running")

    loop_id = f"loop-{uuid.uuid4().hex[:12]}"
    cfg = load_loop_config(req.config_path)
    orch = Orchestrator(config=cfg, state_store=_store, emit_fn=emit_loop_event)

    init_loop_stream(loop_id)

    def _run():
        import logging
        logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
        try:
            orch.run(loop_id=loop_id)
        finally:
            finish_loop_stream(loop_id)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    _running_threads[loop_id] = t

    return {"status": "started", "loop_id": loop_id}


@router.post("/stop")
async def stop_loop():
    """Request a graceful stop of the active loop."""
    active = _store.get_active_loop()
    if not active:
        raise HTTPException(status_code=404, detail="No active loop to stop")

    _store.request_stop(active.loop_id)
    return {"status": "stop_requested", "loop_id": active.loop_id}


@router.get("/status", response_model=LoopStatusResponse | None)
async def get_status():
    """Get status of the most recent loop."""
    state = _store.get_latest_loop()
    if not state:
        return None
    return _state_to_response(state)


@router.get("/status/{loop_id}", response_model=LoopStatusResponse)
async def get_loop_status(loop_id: str):
    """Get status of a specific loop."""
    state = _store.get_loop(loop_id)
    if not state:
        raise HTTPException(status_code=404, detail="Loop not found")
    return _state_to_response(state)


@router.get("/list", response_model=list[LoopListEntry])
async def list_loops(limit: int = 20):
    """List all loop runs."""
    rows = _store.list_loops(limit=limit)
    return [LoopListEntry(**r) for r in rows]


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

@router.get("/configs")
async def list_configs():
    """List available loop config files."""
    configs_dir = _BASE_DIR / "configs"
    results = []
    for p in sorted(configs_dir.glob("loop*.yaml")):
        name = p.stem
        display_name = name.replace("_", " ").replace("loop ", "Loop ").title()
        results.append({"name": name, "path": str(p), "display_name": display_name})
    return results


def _state_to_response(state) -> LoopStatusResponse:
    evolutions = []
    for r in state.evolutions:
        evolutions.append(EvolutionSummary(
            evolution=r.evolution,
            overall_score=r.overall_score,
            factual_accuracy=r.factual_accuracy,
            completeness=r.completeness,
            technical_precision=r.technical_precision,
            best_score_so_far=r.best_score_so_far,
            delta_from_previous=r.delta_from_previous,
            consecutive_regressions=r.consecutive_regressions,
            consecutive_plateaus=r.consecutive_plateaus,
            target_reached=r.target_reached,
            domain_scores=r.domain_scores,
            started_at=r.started_at,
            completed_at=r.completed_at,
        ))
    return LoopStatusResponse(
        loop_id=state.loop_id,
        status=state.status,
        current_evolution=state.current_evolution,
        current_stage=state.current_stage,
        stop_reason=state.stop_reason,
        stop_requested=state.stop_requested,
        created_at=state.created_at,
        updated_at=state.updated_at,
        evolutions=evolutions,
        config_snapshot=state.config_snapshot,
    )
