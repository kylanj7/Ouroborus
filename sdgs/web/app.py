"""FastAPI application for the SDGS web interface."""
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import requests as _requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import CORS_ORIGINS, DATA_DIR
from .db.database import init_db
from .routers.pulse import broadcast_consumer
from .services.job_runner import shutdown_runner

# Configure logging for the entire sdgs package
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
# Quiet noisy libraries
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)

log = logging.getLogger(__name__)

OLLAMA_BASE_URL = "http://localhost:11434"


def _unload_ollama_models() -> None:
    """Unload all Ollama models from VRAM on shutdown."""
    try:
        resp = _requests.get(f"{OLLAMA_BASE_URL}/api/ps", timeout=5)
        resp.raise_for_status()
        models = resp.json().get("models", [])
        for m in models:
            name = m.get("name", "")
            if not name:
                continue
            log.info("Unloading Ollama model: %s", name)
            _requests.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={"model": name, "keep_alive": 0},
                timeout=10,
            )
    except Exception:
        log.debug("Ollama not reachable or no models loaded -- skipping unload")


def _reset_stale_jobs() -> None:
    """Reset datasets and training runs stuck in running/pending from a previous server session."""
    from .db.database import SessionLocal
    from .db.models import Dataset, TrainingRun, EvaluationRun

    db = SessionLocal()
    try:
        stale_ds = db.query(Dataset).filter(Dataset.status.in_(["running", "pending"])).all()
        for ds in stale_ds:
            log.info("Resetting stale dataset %d (%s) from '%s' to 'failed'", ds.id, ds.topic, ds.status)
            ds.status = "failed"

        stale_tr = db.query(TrainingRun).filter(TrainingRun.status.in_(["running", "pending"])).all()
        for tr in stale_tr:
            log.info("Resetting stale training run %d (%s) from '%s' to 'failed'", tr.id, tr.run_name, tr.status)
            tr.status = "failed"
            tr.error_message = "Server shutdown during training"

        stale_ev = db.query(EvaluationRun).filter(EvaluationRun.status.in_(["running", "pending"])).all()
        for ev in stale_ev:
            log.info("Resetting stale evaluation %d (%s) from '%s' to 'failed'", ev.id, ev.run_name, ev.status)
            ev.status = "failed"
            ev.error_message = "Server shutdown during evaluation"

        if stale_ds or stale_tr or stale_ev:
            db.commit()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    init_db()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _reset_stale_jobs()
    consumer_task = asyncio.create_task(broadcast_consumer())
    yield
    consumer_task.cancel()
    shutdown_runner()
    _unload_ollama_models()


app = FastAPI(
    title="Ouroboros",
    description="Ouroboros — AI Training Suite",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API routers
from .routers import auth, datasets, papers, providers, galaxy, sse, settings, training, pulse, loop  # noqa: E402

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(datasets.router, prefix="/api/datasets", tags=["datasets"])
app.include_router(papers.router, prefix="/api/papers", tags=["papers"])
app.include_router(sse.router, prefix="/api/events", tags=["events"])
app.include_router(providers.router, prefix="/api", tags=["providers"])
app.include_router(galaxy.router, prefix="/api/galaxy", tags=["galaxy"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(training.router, prefix="/api/training", tags=["training"])
app.include_router(loop.router, prefix="/api/loop", tags=["loop"])
app.include_router(pulse.router, tags=["pulse"])


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# SPA frontend: serve static assets, fallback to index.html for client-side routing
frontend_dist = Path(__file__).parent / "frontend" / "dist"
if frontend_dist.exists():
    # Serve static assets (JS, CSS, images) directly
    app.mount("/assets", StaticFiles(directory=str(frontend_dist / "assets")), name="static-assets")

    @app.get("/{full_path:path}")
    async def serve_spa(request: Request, full_path: str):
        """Serve index.html for all non-API routes (SPA fallback)."""
        # Try to serve the exact file first (e.g., favicon.ico)
        file_path = frontend_dist / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        # Otherwise serve index.html for client-side routing
        return FileResponse(frontend_dist / "index.html")
