"""Provider listing API with per-user key status."""
import requests
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db.database import get_db
from ..db.models import ApiKey
from ..deps import CurrentUser, get_current_user
from ..schemas import ProviderInfo

router = APIRouter()

OLLAMA_BASE_URL = "http://localhost:11434"


@router.get("/providers", response_model=list[ProviderInfo])
def get_providers(
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from sdgs.providers import list_providers, load_provider_config

    # Get user's stored keys
    user_keys = {
        k.provider_name
        for k in db.query(ApiKey).filter(ApiKey.user_id == current_user.id).all()
    }

    result = []
    for name in list_providers():
        config = load_provider_config(name)
        result.append(ProviderInfo(
            name=name,
            default_model=config.get("default_model", ""),
            api_key_env=config.get("api_key_env"),
            has_key=name in user_keys,
        ))
    return result


@router.get("/providers/models")
def get_ollama_models():
    """List locally available Ollama models."""
    try:
        resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=10)
        resp.raise_for_status()
        return [m["name"] for m in resp.json().get("models", [])]
    except Exception:
        return []
