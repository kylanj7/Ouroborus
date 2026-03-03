"""Dataset execution engine using ThreadPoolExecutor with stdout capture."""
import io
import logging
import sys
import queue
import threading
import datetime
import re
import traceback
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.orm import Session

from ..db.database import SessionLocal
from ..db.models import Dataset

log = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=2)
_job_queues: dict[int, queue.Queue] = {}
_job_futures: dict[int, object] = {}
_job_logs: dict[int, list[dict]] = {}
_cancel_flags: dict[int, threading.Event] = {}
_job_clients: dict[int, object] = {}  # openai client refs for force-close on cancel
_lock = threading.Lock()

# Training/evaluation job infrastructure (separate pool — only 1 GPU job at a time)
_training_executor = ThreadPoolExecutor(max_workers=1)
_training_queues: dict[int, queue.Queue] = {}
_training_futures: dict[int, object] = {}
_training_logs: dict[int, list[dict]] = {}
_training_cancel: dict[int, threading.Event] = {}
_training_lock = threading.Lock()


def _emit(dataset_id: int, q: queue.Queue, item: dict):
    """Append to persistent log buffer and push to the live queue."""
    with _lock:
        if dataset_id not in _job_logs:
            _job_logs[dataset_id] = []
        _job_logs[dataset_id].append(item)
    q.put(item)


def get_job_logs(dataset_id: int) -> list[dict]:
    """Return a snapshot of the stored log buffer for a dataset."""
    with _lock:
        return list(_job_logs.get(dataset_id, []))


def register_job_client(dataset_id: int, client):
    """Store a reference to the LLM client so cancel_job() can close it."""
    with _lock:
        _job_clients[dataset_id] = client


class _ThreadCapture:
    """Per-thread capture state: buffers stdout writes and emits lines to a queue."""

    def __init__(self, job_id: int, q: queue.Queue, emit_fn):
        self.job_id = job_id
        self.q = q
        self._buffer = ""
        self._emit_fn = emit_fn

    def write(self, s: str) -> int:
        if not s:
            return 0
        self._buffer += s
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self._emit_fn(self.job_id, self.q, {"type": "log", "data": line})
        return len(s)

    def flush(self):
        if self._buffer:
            self._emit_fn(self.job_id, self.q, {"type": "log", "data": self._buffer})
            self._buffer = ""


class _ThreadAwareStdout(io.TextIOBase):
    """Multiplexing stdout proxy that routes writes to per-thread captures.

    Threads running dataset/training jobs register a capture; all other threads
    (including the main thread) write to the real stdout.  This avoids the race
    condition of swapping the global sys.stdout from multiple worker threads.
    """

    def __init__(self, real_stdout):
        self._real = real_stdout
        self._captures: dict[int, _ThreadCapture] = {}
        self._lock = threading.Lock()

    def register(self, capture: "_ThreadCapture"):
        tid = threading.current_thread().ident
        with self._lock:
            self._captures[tid] = capture
        log.debug("stdout capture registered for thread %s (job %s)", tid, capture.job_id)

    def unregister(self):
        tid = threading.current_thread().ident
        with self._lock:
            cap = self._captures.pop(tid, None)
        if cap:
            cap.flush()
            log.debug("stdout capture unregistered for thread %s (job %s)", tid, cap.job_id)

    def write(self, s: str) -> int:
        tid = threading.current_thread().ident
        with self._lock:
            capture = self._captures.get(tid)
        if capture:
            return capture.write(s)
        return self._real.write(s)

    def flush(self):
        tid = threading.current_thread().ident
        with self._lock:
            capture = self._captures.get(tid)
        if capture:
            capture.flush()
        else:
            self._real.flush()

    @property
    def encoding(self):
        return getattr(self._real, "encoding", "utf-8")

    def isatty(self):
        return False

    def fileno(self):
        return self._real.fileno()


# Install the thread-aware proxy once at module load
_real_stdout = sys.stdout
_threaded_stdout = _ThreadAwareStdout(_real_stdout)
sys.stdout = _threaded_stdout


def get_job_queue(dataset_id: int) -> queue.Queue | None:
    with _lock:
        return _job_queues.get(dataset_id)


def submit_job(ds_id: int, run_fn, **kwargs):
    """Submit a dataset pipeline for background execution."""
    log.info("[dataset:%d] Submitting job: %s", ds_id, run_fn.__name__)
    q = queue.Queue()
    cancel_event = threading.Event()
    with _lock:
        _job_queues[ds_id] = q
        _cancel_flags[ds_id] = cancel_event

    # Inject cancel_event so pipeline functions can check it
    kwargs["cancel_event"] = cancel_event

    future = _executor.submit(_run_job, ds_id, q, run_fn, kwargs)
    with _lock:
        _job_futures[ds_id] = future
    return future


def cancel_job(dataset_id: int) -> bool:
    """Cancel a running dataset pipeline.

    Sets the cancel flag (checked at iteration boundaries) and closes the
    LLM client to abort any in-flight HTTP request to Ollama/etc.
    """
    with _lock:
        cancel_event = _cancel_flags.get(dataset_id)
        future = _job_futures.get(dataset_id)
        client = _job_clients.pop(dataset_id, None)

    if not cancel_event and not future:
        return False

    # 1. Signal cooperative cancellation
    if cancel_event:
        cancel_event.set()

    # 2. Force-close the LLM client to abort in-flight requests
    if client and hasattr(client, "close"):
        try:
            client.close()
        except Exception:
            pass

    # 3. Try cancelling the future (only works if not yet started)
    if future:
        future.cancel()

    # 4. Mark DB as cancelled (the running thread will also detect this,
    #    but we do it here for immediate UI feedback)
    db = SessionLocal()
    try:
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if ds and ds.status not in ("completed", "failed", "cancelled"):
            ds.status = "cancelled"
            ds.completed_at = datetime.datetime.utcnow()
            db.commit()
    finally:
        db.close()

    q = get_job_queue(dataset_id)
    if q:
        _emit(dataset_id, q, {"type": "status", "data": "cancelled"})
        q.put(None)  # sentinel

    return True


def _run_job(dataset_id: int, q: queue.Queue, run_fn, kwargs: dict):
    """Execute the pipeline function with stdout capture."""
    db = SessionLocal()
    capture = _ThreadCapture(dataset_id, q, _emit)

    try:
        # Mark as running
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return
        ds.status = "running"
        ds.started_at = datetime.datetime.utcnow()
        db.commit()
        log.info("[dataset:%d] Job started", dataset_id)
        _emit(dataset_id, q, {"type": "status", "data": "running"})

        # Register per-thread capture (no global sys.stdout swap)
        _threaded_stdout.register(capture)
        result = run_fn(**kwargs)
        capture.flush()
        _threaded_stdout.unregister()

        # Parse stats from the persistent log buffer (the queue may already
        # be drained by the SSE consumer, so we use _job_logs instead)
        with _lock:
            all_log_items = list(_job_logs.get(dataset_id, []))
        all_lines = [item["data"] for item in all_log_items if item.get("type") == "log"]
        stdout_text = "\n".join(all_lines)
        stats = _parse_stats(stdout_text)

        # Now parse the output files and store papers + QA pairs
        from .dataset_service import parse_dataset_results
        from ..db.models import Paper, QAPair

        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()

        if result and isinstance(result, dict):
            output_path = result.get("output_path", "")
            filtered_path = result.get("filtered_path", output_path)

            parsed = parse_dataset_results(output_path, filtered_path)

            ds.output_path = filtered_path or output_path
            ds.citations_path = result.get("citations_path", "")
            ds.actual_size = parsed["actual_size"]
            ds.valid_count = parsed["valid_count"]
            ds.invalid_count = parsed["invalid_count"]
            ds.healed_count = parsed["healed_count"]

            # Store papers
            for p_data in parsed["papers"]:
                paper = Paper(
                    paper_id=p_data.get("paper_id"),
                    title=p_data.get("title", "Unknown"),
                    authors=p_data.get("authors", []),
                    abstract=p_data.get("abstract", ""),
                    year=p_data.get("year"),
                    doi=p_data.get("doi"),
                    url=p_data.get("url", ""),
                    source=p_data.get("source", ""),
                    citation_count=p_data.get("citation_count", 0),
                    pdf_path=p_data.get("pdf_path"),
                    user_id=ds.user_id,
                    dataset_id=ds.id,
                )
                db.add(paper)
            db.flush()

            # Build paper lookup for FK
            paper_lookup = {}
            for paper in db.query(Paper).filter(Paper.dataset_id == ds.id).all():
                if paper.paper_id:
                    paper_lookup[paper.paper_id] = paper.id

            # Store QA pairs
            for qa_data in parsed["qa_pairs"]:
                source_pid = qa_data.get("source_paper_id", "")
                qa = QAPair(
                    instruction=qa_data["instruction"],
                    output=qa_data["output"],
                    is_valid=qa_data.get("is_valid", True),
                    was_healed=qa_data.get("was_healed", False),
                    source_paper_id=source_pid,
                    source_title=qa_data.get("source_title", ""),
                    think_text=qa_data.get("think_text", ""),
                    answer_text=qa_data.get("answer_text", ""),
                    user_id=ds.user_id,
                    paper_id=paper_lookup.get(source_pid),
                    dataset_id=ds.id,
                )
                db.add(qa)

            # Flush QA pairs so the count query sees them (autoflush=False)
            db.flush()

            # Update paper QA counts
            for paper in db.query(Paper).filter(Paper.dataset_id == ds.id).all():
                paper.qa_pair_count = db.query(QAPair).filter(
                    QAPair.paper_id == paper.id
                ).count()

        # Mark completed
        ds.status = "completed"
        ds.completed_at = datetime.datetime.utcnow()
        ds.prompt_tokens = stats.get("prompt_tokens", 0)
        ds.completion_tokens = stats.get("completion_tokens", 0)
        ds.total_tokens = stats.get("total_tokens", 0)
        ds.gpu_kwh = stats.get("gpu_kwh", 0.0)
        ds.duration_seconds = (
            (ds.completed_at - ds.started_at).total_seconds()
            if ds.started_at else 0.0
        )
        db.commit()

        log.info(
            "[dataset:%d] Job completed: %d pairs, %d valid, %d tokens, %.1fs",
            dataset_id, ds.actual_size or 0, ds.valid_count or 0,
            ds.total_tokens or 0, ds.duration_seconds or 0,
        )
        _emit(dataset_id, q, {"type": "status", "data": "completed"})

    except Exception as e:
        _threaded_stdout.unregister()

        # Check if this was a cancellation (flag set by cancel_job)
        with _lock:
            cancel_event = _cancel_flags.get(dataset_id)
        was_cancelled = cancel_event and cancel_event.is_set()

        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if ds and ds.status not in ("cancelled",):
            if was_cancelled:
                ds.status = "cancelled"
                ds.completed_at = datetime.datetime.utcnow()
                if ds.started_at:
                    ds.duration_seconds = (ds.completed_at - ds.started_at).total_seconds()
                db.commit()
                log.info("[dataset:%d] Job cancelled by user", dataset_id)
                _emit(dataset_id, q, {"type": "log", "data": "Job cancelled by user"})
                _emit(dataset_id, q, {"type": "status", "data": "cancelled"})
            else:
                tb = traceback.format_exc()
                log.error("[dataset:%d] Job failed: %s", dataset_id, e)
                log.debug("[dataset:%d] Traceback:\n%s", dataset_id, tb)
                ds.status = "failed"
                ds.completed_at = datetime.datetime.utcnow()
                ds.error_message = str(e)
                if ds.started_at:
                    ds.duration_seconds = (ds.completed_at - ds.started_at).total_seconds()
                db.commit()
                _emit(dataset_id, q, {"type": "error", "data": str(e)})
                _emit(dataset_id, q, {"type": "log", "data": tb})
                _emit(dataset_id, q, {"type": "status", "data": "failed"})

    finally:
        _threaded_stdout.unregister()  # safe to call twice
        q.put(None)  # sentinel to end SSE stream
        db.close()

        # Cleanup after a delay
        def _cleanup():
            import time
            time.sleep(60)
            with _lock:
                _job_queues.pop(dataset_id, None)
                _job_futures.pop(dataset_id, None)
                _job_logs.pop(dataset_id, None)
                _cancel_flags.pop(dataset_id, None)
                _job_clients.pop(dataset_id, None)

        threading.Thread(target=_cleanup, daemon=True).start()


def _parse_stats(text: str) -> dict:
    """Parse token and GPU stats from captured stdout."""
    stats: dict = {}

    m = re.search(r"Prompt tokens:\s+([\d,]+)", text)
    if m:
        stats["prompt_tokens"] = int(m.group(1).replace(",", ""))

    m = re.search(r"Completion tokens:\s+([\d,]+)", text)
    if m:
        stats["completion_tokens"] = int(m.group(1).replace(",", ""))

    m = re.search(r"Total tokens:\s+([\d,]+)", text)
    if m:
        stats["total_tokens"] = int(m.group(1).replace(",", ""))

    m = re.search(r"Total energy:\s+([\d.]+)\s*kWh", text)
    if m:
        stats["gpu_kwh"] = float(m.group(1))

    return stats


# =====================================================================
# Training / evaluation job infrastructure
# =====================================================================

def _training_emit(run_id: int, q: queue.Queue, item: dict):
    """Append to persistent log buffer and push to the live queue."""
    with _training_lock:
        if run_id not in _training_logs:
            _training_logs[run_id] = []
        _training_logs[run_id].append(item)
    q.put(item)


def get_training_queue(run_id: int) -> queue.Queue | None:
    with _training_lock:
        return _training_queues.get(run_id)


def get_training_logs(run_id: int) -> list[dict]:
    with _training_lock:
        return list(_training_logs.get(run_id, []))


def submit_training_job(run_id: int, run_fn, model_class: str, **kwargs):
    """Submit a training or evaluation job for background execution.

    *model_class* should be ``"TrainingRun"`` or ``"EvaluationRun"`` so the
    runner knows which ORM model to update.
    """
    q: queue.Queue = queue.Queue()
    cancel_event = threading.Event()
    with _training_lock:
        _training_queues[run_id] = q
        _training_cancel[run_id] = cancel_event

    kwargs["cancel_event"] = cancel_event

    future = _training_executor.submit(
        _run_training_job, run_id, q, run_fn, kwargs, model_class,
    )
    with _training_lock:
        _training_futures[run_id] = future
    return future


def cancel_training_job(run_id: int, model_class: str) -> bool:
    """Cancel a running training/evaluation job."""
    with _training_lock:
        cancel_event = _training_cancel.get(run_id)
        future = _training_futures.get(run_id)

    if not cancel_event and not future:
        return False

    if cancel_event:
        cancel_event.set()
    if future:
        future.cancel()

    # Immediate DB update
    from ..db.models import TrainingRun, EvaluationRun
    ModelCls = TrainingRun if model_class == "TrainingRun" else EvaluationRun
    db = SessionLocal()
    try:
        row = db.query(ModelCls).filter(ModelCls.id == run_id).first()
        if row and row.status not in ("completed", "failed", "cancelled"):
            row.status = "cancelled"
            row.completed_at = datetime.datetime.utcnow()
            db.commit()
    finally:
        db.close()

    q = get_training_queue(run_id)
    if q:
        _training_emit(run_id, q, {"type": "status", "data": "cancelled"})
        q.put(None)
    return True


def _run_training_job(
    run_id: int,
    q: queue.Queue,
    run_fn,
    kwargs: dict,
    model_class: str,
):
    """Execute a training/evaluation function with stdout capture."""
    from ..db.models import TrainingRun, EvaluationRun
    ModelCls = TrainingRun if model_class == "TrainingRun" else EvaluationRun

    db = SessionLocal()
    capture = _ThreadCapture(run_id, q, _training_emit)

    try:
        row = db.query(ModelCls).filter(ModelCls.id == run_id).first()
        if not row:
            return
        row.status = "running"
        row.started_at = datetime.datetime.utcnow()
        db.commit()
        log.info("[training:%d] Job started (%s)", run_id, model_class)
        _training_emit(run_id, q, {"type": "status", "data": "running"})

        _threaded_stdout.register(capture)
        result = run_fn(**kwargs)
        capture.flush()
        _threaded_stdout.unregister()

        # Update DB with results
        row = db.query(ModelCls).filter(ModelCls.id == run_id).first()

        if result and isinstance(result, dict):
            if model_class == "TrainingRun":
                row.adapter_path = result.get("adapter_path")
                row.output_dir = result.get("output_dir")
                row.final_loss = result.get("final_loss")
                row.total_steps = result.get("total_steps")
                row.training_runtime_seconds = result.get("training_runtime_seconds")
                row.train_samples = result.get("train_samples", 0)
                row.val_samples = result.get("val_samples", 0)
                row.test_samples = result.get("test_samples", 0)
            else:  # EvaluationRun
                row.factual_accuracy = result.get("factual_accuracy")
                row.completeness = result.get("completeness")
                row.technical_precision = result.get("technical_precision")
                row.overall_accuracy = result.get("overall_accuracy")
                row.purity = result.get("purity")
                row.entropy = result.get("entropy")
                row.samples_scored = result.get("samples_scored", 0)
                row.samples_skipped = result.get("samples_skipped", 0)
                row.samples_failed = result.get("samples_failed", 0)
                row.results_json = result.get("results")
                row.articles_json = result.get("articles")

        row.status = "completed"
        row.completed_at = datetime.datetime.utcnow()
        if row.started_at:
            row.duration_seconds = (row.completed_at - row.started_at).total_seconds()
        db.commit()

        _training_emit(run_id, q, {"type": "status", "data": "completed"})

    except Exception as e:
        _threaded_stdout.unregister()

        with _training_lock:
            cancel_event = _training_cancel.get(run_id)
        was_cancelled = cancel_event and cancel_event.is_set()

        row = db.query(ModelCls).filter(ModelCls.id == run_id).first()
        if row and row.status not in ("cancelled",):
            if was_cancelled:
                row.status = "cancelled"
                row.completed_at = datetime.datetime.utcnow()
                if row.started_at:
                    row.duration_seconds = (row.completed_at - row.started_at).total_seconds()
                db.commit()
                log.info("[training:%d] Job cancelled by user", run_id)
                _training_emit(run_id, q, {"type": "status", "data": "cancelled"})
            else:
                tb = traceback.format_exc()
                log.error("[training:%d] Job failed: %s", run_id, e)
                log.debug("[training:%d] Traceback:\n%s", run_id, tb)
                row.status = "failed"
                row.completed_at = datetime.datetime.utcnow()
                row.error_message = str(e)
                if row.started_at:
                    row.duration_seconds = (row.completed_at - row.started_at).total_seconds()
                db.commit()
                _training_emit(run_id, q, {"type": "error", "data": str(e)})
                _training_emit(run_id, q, {"type": "log", "data": tb})
                _training_emit(run_id, q, {"type": "status", "data": "failed"})

    finally:
        _threaded_stdout.unregister()  # safe to call twice
        q.put(None)
        db.close()

        def _cleanup():
            import time
            time.sleep(60)
            with _training_lock:
                _training_queues.pop(run_id, None)
                _training_futures.pop(run_id, None)
                _training_logs.pop(run_id, None)
                _training_cancel.pop(run_id, None)

        threading.Thread(target=_cleanup, daemon=True).start()


## =====================================================================
# Loop SSE infrastructure (string-keyed, no DB — orchestrator handles state)
# =====================================================================

_loop_queues: dict[str, queue.Queue] = {}
_loop_logs: dict[str, list[dict]] = {}
_loop_lock = threading.Lock()


def init_loop_stream(loop_id: str):
    """Create a queue + log buffer for a loop before starting the thread."""
    with _loop_lock:
        _loop_queues[loop_id] = queue.Queue()
        _loop_logs[loop_id] = []


def emit_loop_event(loop_id: str, event: dict):
    """Push an event to the loop's SSE queue and log buffer."""
    with _loop_lock:
        logs = _loop_logs.get(loop_id)
        if logs is not None:
            logs.append(event)
        q = _loop_queues.get(loop_id)
    if q is not None:
        q.put(event)


def get_loop_queue(loop_id: str) -> queue.Queue | None:
    with _loop_lock:
        return _loop_queues.get(loop_id)


def get_loop_logs(loop_id: str) -> list[dict]:
    with _loop_lock:
        return list(_loop_logs.get(loop_id, []))


def finish_loop_stream(loop_id: str):
    """Send None sentinel and schedule cleanup after 2 minutes."""
    q = get_loop_queue(loop_id)
    if q is not None:
        q.put(None)

    def _cleanup():
        import time
        time.sleep(120)
        with _loop_lock:
            _loop_queues.pop(loop_id, None)
            _loop_logs.pop(loop_id, None)

    threading.Thread(target=_cleanup, daemon=True).start()


def shutdown_runner():
    """Shut down both thread pool executors."""
    _executor.shutdown(wait=False)
    _training_executor.shutdown(wait=False)
