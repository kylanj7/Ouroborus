"""Server-Sent Events endpoint for real-time dataset pipeline progress."""
import asyncio
import json
import queue

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from ..services.job_runner import get_job_queue, get_job_logs, get_training_queue, get_training_logs, get_loop_queue, get_loop_logs

router = APIRouter()

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


async def _await_queue_item(q: queue.Queue, timeout: float = 1.0):
    """Block on a stdlib queue.Queue without busy-waiting by offloading to a thread."""
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, q.get, True, timeout)
    except queue.Empty:
        return _EMPTY_SENTINEL

_EMPTY_SENTINEL = object()


async def _stream_from_queue(q, event_id: int):
    """Shared generator logic: block-wait on queue items and yield SSE frames."""
    while True:
        try:
            item = await _await_queue_item(q)
            if item is _EMPTY_SENTINEL:
                continue
            if item is None:
                yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
                return
            yield f"id: {event_id}\ndata: {json.dumps(item)}\n\n"
            event_id += 1
        except asyncio.CancelledError:
            return


@router.get("/datasets/{dataset_id}")
async def dataset_events(dataset_id: int, last_id: int = Query(0, ge=0)):
    """SSE stream for a running dataset pipeline."""

    async def event_generator():
        stored = get_job_logs(dataset_id)
        event_id = len(stored)

        for i, item in enumerate(stored):
            if i < last_id:
                continue
            yield f"id: {i}\ndata: {json.dumps(item)}\n\n"

        q = get_job_queue(dataset_id)
        if q is None:
            yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
            return

        async for frame in _stream_from_queue(q, event_id):
            yield frame

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.get("/training/{run_id}")
async def training_events(run_id: int, last_id: int = Query(0, ge=0)):
    """SSE stream for a running training/evaluation job."""

    async def event_generator():
        stored = get_training_logs(run_id)
        event_id = len(stored)

        for i, item in enumerate(stored):
            if i < last_id:
                continue
            yield f"id: {i}\ndata: {json.dumps(item)}\n\n"

        q = get_training_queue(run_id)
        if q is None:
            yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
            return

        async for frame in _stream_from_queue(q, event_id):
            yield frame

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.get("/loop/{loop_id}")
async def loop_events(loop_id: str, last_id: int = Query(0, ge=0)):
    """SSE stream for a running evolution loop."""

    async def event_generator():
        stored = get_loop_logs(loop_id)
        event_id = len(stored)

        for i, item in enumerate(stored):
            if i < last_id:
                continue
            yield f"id: {i}\ndata: {json.dumps(item)}\n\n"

        q = get_loop_queue(loop_id)
        if q is None:
            yield f"id: {event_id}\ndata: {json.dumps({'type': 'done', 'data': 'stream_end'})}\n\n"
            return

        async for frame in _stream_from_queue(q, event_id):
            yield frame

    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=_SSE_HEADERS)
