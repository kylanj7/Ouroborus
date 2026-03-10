"""Knowledge base API: semantic search and RAG chat over indexed PDFs."""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..deps import CurrentUser

router = APIRouter()


class ChatRequest(BaseModel):
    query: str
    model: str = "nemotron-3-nano:latest"
    k: int = 5


class IndexRequest(BaseModel):
    force: bool = False


@router.get("/status")
async def knowledge_status(user: CurrentUser):
    from ..services.knowledge_service import get_status
    return get_status()


@router.post("/index")
async def index_papers(body: IndexRequest, user: CurrentUser):
    from ..services.knowledge_service import index_papers
    return index_papers(force=body.force)


@router.get("/search")
async def search_knowledge(
    q: str = Query(..., min_length=1),
    k: int = Query(5, ge=1, le=20),
    user: CurrentUser = None,
):
    from ..services.knowledge_service import search
    results = search(query=q, k=k)
    return {"results": results, "count": len(results)}


@router.post("/chat")
async def chat_knowledge(body: ChatRequest, user: CurrentUser):
    from ..services.knowledge_service import chat
    return chat(query=body.query, model=body.model, k=body.k)


@router.post("/reset")
async def reset_knowledge(user: CurrentUser):
    from ..services.knowledge_service import reset
    reset()
    return {"status": "reset"}
