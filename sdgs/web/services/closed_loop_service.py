"""Closed-loop orchestrator lifecycle management with SSE event broadcasting."""
from __future__ import annotations

import logging
import multiprocessing
import os
import queue
import signal
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
_active_process: multiprocessing.Process | None = None
_active_pid: int | None = None

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
    """Push an event to the closed-loop SSE queue and persistent log buffer."""
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
# Subprocess target
# ---------------------------------------------------------------------------

def _run_loop_subprocess(
    loop_id: str,
    config_path: str | None,
    seed_dataset_path: str | None,
    mp_queue: multiprocessing.Queue,
    parent_pid: int = 0,
) -> None:
    """Entry point for the closed-loop subprocess.

    Runs the orchestrator and sends events back to the parent via mp_queue.
    If the parent server process dies, this subprocess exits too.
    """
    import logging as _logging
    from pathlib import Path as _Path

    # Watchdog thread: exit if parent server dies
    if parent_pid:
        def _parent_watchdog():
            while True:
                import time
                time.sleep(3)
                try:
                    os.kill(parent_pid, 0)  # check if parent is alive
                except OSError:
                    os._exit(1)  # parent is dead, force exit
        watchdog = threading.Thread(target=_parent_watchdog, daemon=True, name="parent-watchdog")
        watchdog.start()

    # Set up logging: console + file + SSE bridge
    log_dir = _Path("logs/loop")
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{loop_id}.log"

    fmt = _logging.Formatter(
        "%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Console handler
    console_handler = _logging.StreamHandler()
    console_handler.setFormatter(fmt)

    # File handler -- persistent log for this loop run
    file_handler = _logging.FileHandler(str(log_file), mode="w")
    file_handler.setFormatter(fmt)

    # SSE bridge handler -- sends events to the parent process
    class _MPLogHandler(_logging.Handler):
        def __init__(self, lid: str, q: multiprocessing.Queue):
            super().__init__()
            self._lid = lid
            self._q = q

        def emit(self, record: _logging.LogRecord) -> None:
            try:
                message = self.format(record)
            except Exception:
                message = record.getMessage()

            self._q.put({"type": "log", "data": message})

            upper = message.upper()
            stage_keywords = {
                "BASELINE": "baseline", "TALLYING": "tallying",
                "RETRIEVING": "retrieving", "CURATING": "curating",
                "TRAINING": "training", "MERGING": "merging",
                "EVALUATING": "evaluating", "GATING": "gating",
            }
            for keyword, stage_value in stage_keywords.items():
                if keyword in upper:
                    self._q.put({"type": "stage", "data": stage_value})
                    break

    sse_handler = _MPLogHandler(loop_id, mp_queue)
    sse_handler.setFormatter(fmt)

    # Attach all handlers to the root logger so ALL modules are captured
    root_logger = _logging.getLogger()
    root_logger.setLevel(_logging.INFO)
    root_logger.addHandler(console_handler)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(sse_handler)

    # Quiet noisy libraries
    for noisy in ("httpx", "httpcore", "urllib3", "filelock", "huggingface_hub"):
        _logging.getLogger(noisy).setLevel(_logging.WARNING)

    root_logger.info("[closed-loop:%s] Log file: %s", loop_id, log_file)

    try:
        from sdgs.loop.config_v2 import load_closed_loop_config
        from sdgs.loop.orchestrator_v2 import ClosedLoopOrchestrator

        mp_queue.put({"type": "status", "data": "running"})
        config = load_closed_loop_config(config_path)
        orchestrator = ClosedLoopOrchestrator(config=config, seed_dataset_path=seed_dataset_path)
        orchestrator.run(loop_id=loop_id)
        mp_queue.put({"type": "status", "data": "completed"})

    except Exception as exc:
        tb = traceback.format_exc()
        root_logger.error("[closed-loop:%s] CRASH: %s\n%s", loop_id, exc, tb)
        mp_queue.put({"type": "error", "data": str(exc)})
        mp_queue.put({"type": "log", "data": f"ERROR: {tb}"})
        mp_queue.put({"type": "status", "data": "failed"})

    finally:
        root_logger.info("[closed-loop:%s] Subprocess exiting", loop_id)
        root_logger.removeHandler(console_handler)
        root_logger.removeHandler(file_handler)
        root_logger.removeHandler(sse_handler)
        file_handler.close()
        mp_queue.put(None)  # sentinel


# ---------------------------------------------------------------------------
# Orchestrator lifecycle
# ---------------------------------------------------------------------------

def start_closed_loop(config_path: str | None = None, seed_dataset_path: str | None = None) -> str:
    """Start a new closed-loop run in a subprocess.

    Raises RuntimeError if a loop is already active.
    """
    global _active_loop_id, _active_process, _active_pid

    with _cl_lock:
        if _active_loop_id is not None:
            raise RuntimeError(
                f"A closed-loop run is already active: {_active_loop_id}"
            )
        loop_id = f"cl-{uuid4().hex[:8]}"
        _active_loop_id = loop_id

    init_cl_stream(loop_id)
    log.info("[closed-loop:%s] Starting background orchestrator subprocess", loop_id)

    # Create a multiprocessing queue for events from the subprocess
    # Use 'spawn' context so CUDA can initialize cleanly in the child process
    ctx = multiprocessing.get_context("spawn")
    mp_queue: multiprocessing.Queue = ctx.Queue()

    proc = ctx.Process(
        target=_run_loop_subprocess,
        args=(loop_id, config_path, seed_dataset_path, mp_queue, os.getpid()),
        daemon=True,
        name=f"closed-loop-{loop_id}",
    )
    proc.start()

    with _cl_lock:
        _active_process = proc
        _active_pid = proc.pid

    log.info("[closed-loop:%s] Subprocess PID=%s", loop_id, proc.pid)

    # Bridge thread: reads from mp_queue and pushes to the SSE queue
    def _bridge():
        global _active_loop_id, _active_process, _active_pid
        log.info("[closed-loop:%s] Bridge thread started", loop_id)
        while True:
            try:
                event = mp_queue.get(timeout=2.0)
            except queue.Empty:
                # Check if process is still alive
                if not proc.is_alive():
                    log.info("[closed-loop:%s] Bridge: subprocess exited", loop_id)
                    break
                continue
            except Exception as exc:
                log.error("[closed-loop:%s] Bridge: queue.get error: %s", loop_id, exc)
                if not proc.is_alive():
                    break
                continue

            if event is None:
                log.info("[closed-loop:%s] Bridge: received sentinel, ending", loop_id)
                break

            emit_cl_event(loop_id, event)

        # Cleanup
        proc.join(timeout=5)
        with _cl_lock:
            if _active_loop_id == loop_id:
                _active_loop_id = None
                _active_process = None
                _active_pid = None
        finish_cl_stream(loop_id)
        log.info("[closed-loop:%s] Bridge thread finished", loop_id)

    threading.Thread(target=_bridge, daemon=True, name=f"cl-bridge-{loop_id}").start()

    return loop_id


def force_cancel_loop() -> str | None:
    """Force-cancel the active loop by killing the subprocess."""
    global _active_loop_id, _active_process, _active_pid

    with _cl_lock:
        old_id = _active_loop_id
        proc = _active_process
        pid = _active_pid
        _active_loop_id = None
        _active_process = None
        _active_pid = None

    # Kill the subprocess and all its children
    if pid is not None:
        try:
            os.kill(pid, signal.SIGKILL)
            log.info("[closed-loop:%s] Killed subprocess PID=%s", old_id, pid)
        except ProcessLookupError:
            log.info("[closed-loop:%s] Subprocess PID=%s already dead", old_id, pid)
        except Exception as e:
            log.warning("[closed-loop:%s] Could not kill PID=%s: %s", old_id, pid, e)

    if proc is not None:
        proc.join(timeout=3)

    if old_id:
        log.info("[closed-loop:%s] Force-cancelled", old_id)
        emit_cl_event(old_id, {"type": "status", "data": "cancelled"})
        emit_cl_event(old_id, {"type": "log", "data": "Force-cancelled by user"})
        finish_cl_stream(old_id)

    return old_id


def stop_closed_loop() -> str | None:
    """Request a graceful stop of the currently active closed-loop run."""
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
# Private: SSE log handler (kept for backward compat but no longer primary)
# ---------------------------------------------------------------------------

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

        upper = message.upper()
        for keyword, stage_value in _STAGE_KEYWORDS.items():
            if keyword in upper:
                emit_cl_event(
                    self._loop_id,
                    {"type": "stage", "data": stage_value},
                )
                break
