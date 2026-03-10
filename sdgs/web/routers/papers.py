"""Papers API: list and search papers used in dataset generation."""
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..auth import decrypt_value
from ..db.database import get_db
from ..db.models import Paper, Dataset, User
from ..deps import CurrentUser, get_current_user
from ..schemas import PaperListResponse, PaperResponse

router = APIRouter()


class ScrapeRequest(BaseModel):
    topic: str
    max_results: int = 20


@router.get("/topics", response_model=list[str])
def get_paper_topics(
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return distinct dataset topics that have papers for this user."""
    rows = (
        db.query(Dataset.topic)
        .join(Paper, Paper.dataset_id == Dataset.id)
        .filter(Paper.user_id == current_user.id)
        .distinct()
        .all()
    )
    topics = sorted(t[0] for t in rows if t[0])
    return topics


@router.delete("/{paper_id}")
def delete_paper(
    paper_id: int,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    paper = db.query(Paper).filter(
        Paper.id == paper_id,
        Paper.user_id == current_user.id,
    ).first()
    if not paper:
        raise HTTPException(404, "Paper not found")
    db.delete(paper)
    db.commit()
    return {"status": "deleted"}


@router.post("/bulk-delete")
def bulk_delete_papers(
    req: dict,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete multiple papers by ID."""
    paper_ids = req.get("paper_ids", [])
    if not paper_ids:
        raise HTTPException(400, "No paper IDs provided")
    deleted = db.query(Paper).filter(
        Paper.id.in_(paper_ids),
        Paper.user_id == current_user.id,
    ).delete(synchronize_session=False)
    db.commit()
    return {"deleted": deleted}


@router.get("", response_model=PaperListResponse)
def list_papers(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    search: str | None = None,
    dataset_id: int | None = None,
    topic: str | None = None,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(Paper).filter(Paper.user_id == current_user.id)

    if dataset_id is not None:
        query = query.filter(Paper.dataset_id == dataset_id)

    if topic:
        query = query.join(Dataset, Paper.dataset_id == Dataset.id).filter(
            Dataset.topic.ilike(f"%{topic}%")
        )

    if search:
        pattern = f"%{search}%"
        query = query.filter(
            Paper.title.ilike(pattern)
            | Paper.paper_id.ilike(pattern)
        )

    total = query.count()
    papers = (
        query.order_by(Paper.id.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )

    return PaperListResponse(
        papers=[PaperResponse.model_validate(p) for p in papers],
        total=total,
        page=page,
        per_page=per_page,
    )


@router.get("/{paper_id}/pdf")
def download_paper_pdf(
    paper_id: int,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    paper = db.query(Paper).filter(
        Paper.id == paper_id,
        Paper.user_id == current_user.id,
    ).first()
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    if not paper.pdf_path:
        raise HTTPException(status_code=404, detail="No PDF available for this paper")

    pdf_file = Path(paper.pdf_path)
    if not pdf_file.is_file():
        raise HTTPException(status_code=404, detail="PDF file not found on disk")

    safe_title = paper.title[:80].replace('"', "'")
    return FileResponse(
        path=str(pdf_file),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe_title}.pdf"'},
    )


@router.post("/scrape")
def scrape_papers(
    req: ScrapeRequest,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Search scholarly APIs for papers on a topic and save them to the database."""
    from ...scrape import search_papers

    # Resolve optional API keys
    s2_api_key = None
    core_api_key = None
    user = db.query(User).filter(User.id == current_user.id).first()
    if user and current_user.encryption_key:
        if user.s2_token:
            try:
                s2_api_key = decrypt_value(user.s2_token, current_user.encryption_key)
            except Exception:
                pass
        if user.core_token:
            try:
                core_api_key = decrypt_value(user.core_token, current_user.encryption_key)
            except Exception:
                pass
    if not s2_api_key:
        s2_api_key = os.environ.get("S2_API_KEY")
    if not core_api_key:
        core_api_key = os.environ.get("CORE_API_KEY")

    results = search_papers(
        topic=req.topic,
        max_results=req.max_results,
        s2_api_key=s2_api_key,
        core_api_key=core_api_key,
    )

    saved = 0
    for p_data in results:
        # Skip duplicates by paper_id for this user
        if p_data.get("paper_id"):
            existing = db.query(Paper).filter(
                Paper.user_id == current_user.id,
                Paper.paper_id == p_data["paper_id"],
            ).first()
            if existing:
                continue

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
            user_id=current_user.id,
            dataset_id=None,
        )
        db.add(paper)
        saved += 1

    db.commit()
    return {"saved": saved, "searched": len(results)}
