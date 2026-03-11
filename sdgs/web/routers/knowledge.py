"""Knowledge base API: semantic search and RAG chat over indexed PDFs."""
import json

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
    model: str = "nemotron-3-nano:latest"
    k: int = 5


@router.get("/status")
async def knowledge_status(user: CurrentUser = Depends(get_current_user)):
    from ..services.knowledge_service import get_status
    return get_status()


@router.get("/index")
async def index_papers(
    force: bool = Query(False),
    user: CurrentUser = Depends(get_current_user),
):
    from ..services.knowledge_service import index_papers_stream

    def event_stream():
        for event in index_papers_stream(force=force):
            yield _sse(event)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS)


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
    return chat(query=body.query, model=body.model, k=body.k)


@router.post("/reset")
async def reset_knowledge(user: CurrentUser = Depends(get_current_user)):
    from ..services.knowledge_service import reset
    reset()
    return {"status": "reset"}
