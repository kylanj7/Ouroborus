"""Closed-loop orchestrator lifecycle management with SSE event broadcasting."""
from __future__ import annotations

import logging
import queue
import threading
import traceback
from uuid import uuid4

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level state (thread-safe)
# ---------------------------------------------------------------------------

_cl_queues: dict[str, queue.Queue] = {}
_cl_logs: dict[str, list[dict]] = {}
_cl_lock: threading.Lock = threading.Lock()
_active_loop_id: str | None = None

# Per-loop incrementing event ID counter
_cl_event_counters: dict[str, int] = {}


# ---------------------------------------------------------------------------
# Stream lifecycle
# ---------------------------------------------------------------------------

def init_cl_stream(loop_id: str) -> None:
    """Create a queue and log buffer for a closed-loop run before the thread starts."""
    with _cl_lock:
        _cl_queues[loop_id] = queue.Queue()
        _cl_logs[loop_id] = []
        _cl_event_counters[loop_id] = 0


def emit_cl_event(loop_id: str, event: dict) -> None:
    """Push an event to the closed-loop SSE queue and persistent log buffer.

    Automatically assigns an incrementing ``id`` field to each event.
    """
    with _cl_lock:
        counter = _cl_event_counters.get(loop_id, 0)
        event = {**event, "id": counter}
        _cl_event_counters[loop_id] = counter + 1

        logs = _cl_logs.get(loop_id)
        if logs is not None:
            logs.append(event)

        q = _cl_queues.get(loop_id)

    if q is not None:
        q.put(event)


def finish_cl_stream(loop_id: str) -> None:
    """Push None sentinel to the queue to signal end-of-stream, then schedule cleanup."""
    q = get_cl_queue(loop_id)
    if q is not None:
        q.put(None)

    def _cleanup() -> None:
        import time
        time.sleep(120)
        with _cl_lock:
            _cl_queues.pop(loop_id, None)
            _cl_logs.pop(loop_id, None)
            _cl_event_counters.pop(loop_id, None)

    threading.Thread(target=_cleanup, daemon=True).start()


def get_cl_queue(loop_id: str) -> queue.Queue | None:
    """Return the live SSE queue for a loop, or None if it does not exist."""
    with _cl_lock:
        return _cl_queues.get(loop_id)


def get_cl_logs(loop_id: str) -> list[dict]:
    """Return a snapshot of the stored log buffer for a loop."""
    with _cl_lock:
        return list(_cl_logs.get(loop_id, []))


def get_active_loop_id() -> str | None:
    """Return the loop_id of the currently active closed-loop run, or None."""
    with _cl_lock:
        return _active_loop_id


# ---------------------------------------------------------------------------
# Orchestrator lifecycle
# ---------------------------------------------------------------------------

def start_closed_loop(config_path: str | None = None) -> str:
    """Start a new closed-loop run in a background thread.

    Raises RuntimeError if a loop is already active.

    Returns:
        The generated loop_id for the new run.
    """
    global _active_loop_id

    with _cl_lock:
        if _active_loop_id is not None:
            raise RuntimeError(
                f"A closed-loop run is already active: {_active_loop_id}"
            )
        loop_id = f"cl-{uuid4().hex[:8]}"
        _active_loop_id = loop_id

    init_cl_stream(loop_id)
    log.info("[closed-loop:%s] Starting background orchestrator thread", loop_id)

    def _run() -> None:
        global _active_loop_id

        from sdgs.loop.config_v2 import load_closed_loop_config
        from sdgs.loop.orchestrator_v2 import ClosedLoopOrchestrator

        handler = _SSELogHandler(loop_id)
        sdgs_loop_logger = logging.getLogger("sdgs.loop")
        sdgs_loop_logger.addHandler(handler)

        try:
            emit_cl_event(loop_id, {"type": "status", "data": "running"})
            config = load_closed_loop_config(config_path)
            orchestrator = ClosedLoopOrchestrator(config=config)
            orchestrator.run(loop_id=loop_id)
            emit_cl_event(loop_id, {"type": "status", "data": "completed"})
            log.info("[closed-loop:%s] Orchestrator finished", loop_id)

        except Exception as exc:
            tb = traceback.format_exc()
            import sys
            print(f"[closed-loop:{loop_id}] CRASH:\n{tb}", file=sys.stderr, flush=True)
            log.error("[closed-loop:%s] Orchestrator failed: %s\n%s", loop_id, exc, tb)
            emit_cl_event(loop_id, {"type": "error", "data": str(exc)})
            emit_cl_event(loop_id, {"type": "log", "message": f"ERROR: {tb}"})
            emit_cl_event(loop_id, {"type": "status", "data": "failed"})

        finally:
            sdgs_loop_logger.removeHandler(handler)
            with _cl_lock:
                if _active_loop_id == loop_id:
                    _active_loop_id = None
            finish_cl_stream(loop_id)

    thread = threading.Thread(target=_run, name=f"closed-loop-{loop_id}", daemon=True)
    thread.start()
    return loop_id


def stop_closed_loop() -> str | None:
    """Request a stop on the currently active closed-loop run.

    Uses LoopStateStore to find the active loop and calls request_stop().

    Returns:
        The loop_id that was stopped, or None if no active loop was found.
    """
    from sdgs.loop.state_v2 import LoopStateStore

    store = LoopStateStore()
    try:
        active = store.get_active_loop()
        if active is None:
            return None
        store.request_stop(active.loop_id)
        log.info("[closed-loop:%s] Stop requested", active.loop_id)
        return active.loop_id
    finally:
        store.close()


# ---------------------------------------------------------------------------
# Private: SSE log handler
# ---------------------------------------------------------------------------

# Stage keyword patterns from orchestrator log messages
_STAGE_KEYWORDS: dict[str, str] = {
    "BASELINE": "baseline",
    "TALLYING": "tallying",
    "RETRIEVING": "retrieving",
    "CURATING": "curating",
    "TRAINING": "training",
    "MERGING": "merging",
    "EVALUATING": "evaluating",
    "GATING": "gating",
}


class _SSELogHandler(logging.Handler):
    """Logging handler that captures records from the ``sdgs.loop`` logger
    and re-emits them as SSE events via :func:`emit_cl_event`.

    Detects stage-related log messages and emits an additional ``stage``
    event when a stage transition is identified.
    """

    def __init__(self, loop_id: str) -> None:
        super().__init__()
        self._loop_id = loop_id

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
        except Exception:
            message = record.getMessage()

        emit_cl_event(self._loop_id, {"type": "log", "data": message})

        # Detect stage transitions by scanning the formatted message
        upper = message.upper()
        for keyword, stage_value in _STAGE_KEYWORDS.items():
            if keyword in upper:
                emit_cl_event(
                    self._loop_id,
                    {"type": "stage", "data": stage_value},
                )
                break
