"""Papers API: list and search papers used in dataset generation."""
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse
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
    year_min: int | None = None
    year_max: int | None = None
    sources: list[str] | None = None


@router.get("/topics", response_model=list[str])
def get_paper_topics(
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return distinct paper topics for this user."""
    rows = (
        db.query(Paper.topic)
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
        query = query.filter(Paper.topic == topic)

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

    # If no local PDF but we have a remote URL, fetch and save it on demand
    if (not paper.pdf_path or not Path(paper.pdf_path).is_file()) and paper.pdf_url:
        try:
            from ...scrape import _get_session, _PDF_HEADERS
            import re

            resp = _get_session().get(paper.pdf_url, headers=_PDF_HEADERS, timeout=60, stream=True)
            resp.raise_for_status()

            pdf_dir = Path(__file__).resolve().parent.parent.parent.parent / "data" / "pdfs"
            pdf_dir.mkdir(parents=True, exist_ok=True)
            safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', paper.paper_id or "unknown")[:100]
            local_path = pdf_dir / f"{safe_name}.pdf"
            local_path.write_bytes(resp.content)

            paper.pdf_path = str(local_path)
            db.commit()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Failed to fetch PDF: {e}")

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
    from ...classify import classify_paper

    results, _ = _run_scrape(req, current_user, db)

    saved = 0
    for p_data in results:
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
            topic=classify_paper(p_data.get("title", ""), p_data.get("abstract", "")),
            citation_count=p_data.get("citation_count", 0),
            pdf_url=p_data.get("pdf_url"),
            pdf_path=p_data.get("pdf_path"),
            user_id=current_user.id,
            dataset_id=None,
        )
        db.add(paper)
        saved += 1

    db.commit()
    return {"saved": saved, "searched": len(results)}


@router.post("/scrape/stream")
async def scrape_papers_stream(
    req: ScrapeRequest,
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """SSE endpoint that streams scrape progress. Scrape runs in background thread
    so it completes even if the client disconnects."""
    import json
    import asyncio
    import queue
    import threading
    from ...scrape import _search_arxiv, _search_semantic_scholar, _search_openalex, _search_core, _is_english
    from ...classify import classify_paper
    from ..db.database import SessionLocal

    # Resolve API keys before spawning thread
    s2_api_key = None
    core_api_key = None
    user = db.query(User).filter(User.id == current_user.id).first()
    user_id = current_user.id
    enc_key = current_user.encryption_key
    if user and enc_key:
        if user.s2_token:
            try:
                s2_api_key = decrypt_value(user.s2_token, enc_key)
            except Exception:
                pass
        if user.core_token:
            try:
                core_api_key = decrypt_value(user.core_token, enc_key)
            except Exception:
                pass
    if not s2_api_key:
        s2_api_key = os.environ.get("S2_API_KEY")
    if not core_api_key:
        core_api_key = os.environ.get("CORE_API_KEY")

    enabled = set(req.sources) if req.sources else {"arxiv", "semantic_scholar", "openalex", "core"}
    progress_queue: queue.Queue = queue.Queue()

    def _scrape_worker():
        """Runs in a background thread -- completes regardless of client connection."""
        thread_db = SessionLocal()
        try:
            all_papers: list[dict] = []
            source_fns = []
            if "arxiv" in enabled:
                source_fns.append(("arXiv", lambda: _search_arxiv(req.topic, req.max_results)))
            if "semantic_scholar" in enabled:
                source_fns.append(("Semantic Scholar", lambda: _search_semantic_scholar(req.topic, req.max_results, s2_api_key=s2_api_key, year_min=req.year_min, year_max=req.year_max)))
            if "openalex" in enabled:
                source_fns.append(("OpenAlex", lambda: _search_openalex(req.topic, req.max_results, year_min=req.year_min, year_max=req.year_max)))
            if "core" in enabled:
                source_fns.append(("CORE", lambda: _search_core(req.topic, req.max_results, core_api_key=core_api_key)))

            total_sources = len(source_fns)
            progress_queue.put(("progress", {"stage": "start", "message": f"Searching {total_sources} sources for \"{req.topic}\"...", "sources_total": total_sources, "sources_done": 0}))

            for i, (name, fn) in enumerate(source_fns):
                progress_queue.put(("progress", {"stage": "searching", "source": name, "message": f"Searching {name}...", "sources_total": total_sources, "sources_done": i}))
                try:
                    results = fn()
                    all_papers.extend(results)
                    progress_queue.put(("progress", {"stage": "source_done", "source": name, "found": len(results), "message": f"{name}: {len(results)} papers found", "sources_total": total_sources, "sources_done": i + 1}))
                except Exception as e:
                    progress_queue.put(("progress", {"stage": "source_error", "source": name, "message": f"{name}: error - {str(e)[:100]}", "sources_total": total_sources, "sources_done": i + 1}))

            progress_queue.put(("progress", {"stage": "dedup", "message": f"Deduplicating {len(all_papers)} results...", "sources_total": total_sources, "sources_done": total_sources}))

            seen_ids: set[str] = set()
            seen_titles: set[str] = set()
            merged: list[dict] = []
            for paper in all_papers:
                pid = paper["paper_id"]
                title_key = paper["title"].lower().strip()
                if pid in seen_ids or title_key in seen_titles:
                    continue
                check_text = f"{paper.get('title', '')} {paper.get('abstract', '')}"
                if not _is_english(check_text):
                    continue
                paper_year = paper.get("year")
                if paper_year:
                    if req.year_min and paper_year < req.year_min:
                        continue
                    if req.year_max and paper_year > req.year_max:
                        continue
                seen_ids.add(pid)
                seen_titles.add(title_key)
                merged.append(paper)

            merged.sort(key=lambda p: p["citation_count"], reverse=True)
            merged = merged[:req.max_results]

            progress_queue.put(("progress", {"stage": "saving", "message": f"Saving {len(merged)} papers to database...", "sources_total": total_sources, "sources_done": total_sources}))

            saved = 0
            for p_data in merged:
                if p_data.get("paper_id"):
                    existing = thread_db.query(Paper).filter(
                        Paper.user_id == user_id,
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
                    topic=classify_paper(p_data.get("title", ""), p_data.get("abstract", "")),
                    citation_count=p_data.get("citation_count", 0),
                    pdf_url=p_data.get("pdf_url"),
                    pdf_path=p_data.get("pdf_path"),
                    user_id=user_id,
                    dataset_id=None,
                )
                thread_db.add(paper)
                saved += 1

            thread_db.commit()
            progress_queue.put(("done", {"stage": "done", "message": f"Done! Saved {saved} new papers ({len(merged)} searched)", "saved": saved, "searched": len(merged)}))
        except Exception as e:
            progress_queue.put(("done", {"stage": "error", "message": f"Scrape failed: {str(e)[:200]}", "saved": 0, "searched": 0}))
        finally:
            thread_db.close()

    # Start scrape in background thread -- it will complete even if client disconnects
    thread = threading.Thread(target=_scrape_worker, daemon=True)
    thread.start()

    async def event_generator():
        while True:
            try:
                event_type, data = await asyncio.get_event_loop().run_in_executor(None, lambda: progress_queue.get(timeout=120))
                yield {"event": event_type, "data": json.dumps(data)}
                if event_type == "done":
                    break
            except queue.Empty:
                break

    return EventSourceResponse(event_generator())


def _run_scrape(req: ScrapeRequest, current_user: CurrentUser, db: Session):
    """Shared scrape logic -- returns (results, api_keys)."""
    from ...scrape import search_papers

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
        year_min=req.year_min,
        year_max=req.year_max,
        sources=req.sources,
    )
    return results, (s2_api_key, core_api_key)
