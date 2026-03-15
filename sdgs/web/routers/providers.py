"""Provider listing API -- always uses Ollama backend."""
import logging

import requests
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..deps import CurrentUser, get_current_user
from ..schemas import ProviderInfo

router = APIRouter()
log = logging.getLogger(__name__)

OLLAMA_BASE_URL = "http://localhost:11434"


@router.get("/providers", response_model=list[ProviderInfo])
def get_providers(
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from sdgs.providers import load_provider_config

    config = load_provider_config("ollama")
    return [ProviderInfo(
        name="ollama",
        default_model=config.get("default_model", ""),
        api_key_env=config.get("api_key_env"),
        has_key=True,
    )]


@router.get("/providers/models")
def get_ollama_models():
    """List locally available Ollama models."""
    try:
        resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=10)
        resp.raise_for_status()
        models = [m["name"] for m in resp.json().get("models", [])]
        log.info("Ollama models found: %s", models)
        return models
    except Exception as exc:
        log.warning("Failed to fetch Ollama models: %s", exc)
        return []
