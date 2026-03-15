"""Knowledge base API: semantic search and RAG chat over indexed PDFs."""
import asyncio
import json
import queue

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..deps import CurrentUser, get_current_user

router = APIRouter()

_SSE_HEADERS = {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


class ChatRequest(BaseModel):
    query: str
    model: str = "gpt-oss:120b"
    k: int = 5
    temperature: float = 0.7
    top_k: int = 40
    max_tokens: int = 2048


@router.get("/status")
async def knowledge_status(user: CurrentUser = Depends(get_current_user)):
    from ..services.knowledge_service import get_status
    return get_status()


@router.post("/index")
async def index_papers(
    force: bool = Query(False),
    user: CurrentUser = Depends(get_current_user),
):
    """Start background indexing. Returns immediately."""
    from ..services.knowledge_service import start_indexing, is_indexing

    if is_indexing():
        return {"status": "already_running"}

    started = start_indexing(force=force)
    return {"status": "started" if started else "already_running"}


@router.get("/index/status")
async def index_status(user: CurrentUser = Depends(get_current_user)):
    """Check whether indexing is currently running."""
    from ..services.knowledge_service import is_indexing, get_index_logs

    logs = get_index_logs()
    return {"running": is_indexing(), "logs_count": len(logs)}


@router.post("/index/cancel")
async def cancel_indexing(user: CurrentUser = Depends(get_current_user)):
    """Cancel a running indexing operation."""
    from ..services.knowledge_service import stop_indexing
    stopped = stop_indexing()
    return {"status": "cancelled" if stopped else "not_running"}


@router.get("/index/events")
async def index_events(
    last_id: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
):
    """SSE stream for indexing progress. Supports reconnection via last_id."""
    from ..services.knowledge_service import get_index_logs, get_index_queue

    async def _await_item(q: queue.Queue, timeout: float = 1.0):
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, q.get, True, timeout)
        except queue.Empty:
            return _EMPTY

    _EMPTY = object()

    async def event_generator():
        # Replay stored logs
        stored = get_index_logs()
        event_id = len(stored)

        for i, item in enumerate(stored):
            if i < last_id:
                continue
            yield f"id: {i}\ndata: {json.dumps(item)}\n\n"

        # Stream live events from queue
        q = get_index_queue()
        if q is None:
            yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
            return

        while True:
            try:
                item = await _await_item(q)
                if item is _EMPTY:
                    continue
                if item is None:
                    yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
                    return
                yield f"id: {event_id}\ndata: {json.dumps(item)}\n\n"
                event_id += 1
            except asyncio.CancelledError:
                return

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.get("/search")
async def search_knowledge(
    q: str = Query(..., min_length=1),
    k: int = Query(5, ge=1, le=20),
    user: CurrentUser = Depends(get_current_user),
):
    from ..services.knowledge_service import search
    results = search(query=q, k=k)
    return {"results": results, "count": len(results)}


@router.post("/chat")
async def chat_knowledge(body: ChatRequest, user: CurrentUser = Depends(get_current_user)):
    from ..services.knowledge_service import chat
    return chat(query=body.query, model=body.model, k=body.k, temperature=body.temperature, top_k=body.top_k, max_tokens=body.max_tokens)


@router.post("/reset")
async def reset_knowledge(user: CurrentUser = Depends(get_current_user)):
    from ..services.knowledge_service import reset
    reset()
    return {"status": "reset"}
