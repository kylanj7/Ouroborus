"""Ollama model load/unload helpers for VRAM management."""
import logging
import requests

logger = logging.getLogger(__name__)
OLLAMA_BASE = "http://localhost:11434"

def unload_model(model_name: str):
    """Unload a model from Ollama VRAM via keep_alive: 0."""
    try:
        requests.post(f"{OLLAMA_BASE}/api/generate",
                      json={"model": model_name, "keep_alive": 0}, timeout=30)
        logger.info(f"Unloaded model {model_name} from VRAM")
    except Exception as e:
        logger.warning(f"Failed to unload {model_name}: {e}")


def unload_all_models():
    """Unload ALL models currently loaded in Ollama to free VRAM."""
    try:
        resp = requests.get(f"{OLLAMA_BASE}/api/ps", timeout=5)
        resp.raise_for_status()
        models = resp.json().get("models", [])
        for m in models:
            name = m.get("name", "")
            if name:
                unload_model(name)
        if models:
            logger.info("Unloaded %d Ollama model(s) from VRAM", len(models))
    except Exception as e:
        logger.debug("Ollama not reachable or no models loaded: %s", e)

def ensure_model_loaded(model_name: str):
    """Ensure a model is loaded in Ollama."""
    try:
        requests.post(f"{OLLAMA_BASE}/api/generate",
                      json={"model": model_name, "prompt": "", "keep_alive": "5m"}, timeout=120)
        logger.info(f"Model {model_name} loaded in VRAM")
    except Exception as e:
        logger.error(f"Failed to load {model_name}: {e}")
        raise
