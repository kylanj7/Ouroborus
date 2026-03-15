"""Scholarly paper search, full-text extraction, and Q&A generation pipeline."""
import io
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .tracker import GPUTracker, TokenTracker
from .validate import validate_output


# ── Browser-like headers for PDF fetching ─────────────────────────────

_PDF_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/pdf,*/*;q=0.8",
}


# ── Retry session ─────────────────────────────────────────────────────

_session: requests.Session | None = None


def _get_session() -> requests.Session:
    """Return a shared requests.Session with automatic retry on transient errors."""
    global _session
    if _session is None:
        _session = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503],
            allowed_methods=["GET"],
            respect_retry_after_header=True,
        )
        adapter = HTTPAdapter(max_retries=retry)
        _session.mount("https://", adapter)
        _session.mount("http://", adapter)
    return _session


# ── Rate limiting ──────────────────────────────────────────────────────

_last_request = {}


def _rate_limit(source: str, delay: float):
    """Simple per-source rate limiter."""
    now = time.time()
    last = _last_request.get(source, 0)
    wait = delay - (now - last)
    if wait > 0:
        time.sleep(wait)
    _last_request[source] = time.time()


# ── Language detection ─────────────────────────────────────────────────

# Characters outside Basic Latin + Latin Extended suggest non-English text
_NON_LATIN_RE = re.compile(r"[\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0600-\u06FF\u0900-\u097F]")
# Common English articles/prepositions — if none appear, likely not English
_ENGLISH_MARKERS = re.compile(r"\b(?:the|of|and|in|for|is|to|a|an|with|from|by|on|are|was|that|this)\b", re.I)


def _is_english(text: str) -> bool:
    """Heuristic check: returns True if text appears to be in English."""
    if not text or len(text) < 20:
        return True  # too short to judge, keep it
    # Reject if significant non-Latin script present
    non_latin = len(_NON_LATIN_RE.findall(text))
    if non_latin > len(text) * 0.05:
        return False
    # Must contain some common English words
    return bool(_ENGLISH_MARKERS.search(text))


# ── Paper search ───────────────────────────────────────────────────────

def _search_arxiv(topic: str, max_results: int) -> list[dict]:
    """Search arXiv via its API and return paper metadata dicts."""
    papers = []
    try:
        import arxiv

        client = arxiv.Client()
        search = arxiv.Search(
            query=topic,
            max_results=max_results,
            sort_by=arxiv.SortCriterion.Relevance,
        )
        for result in client.results(search):
            _rate_limit("arxiv", 0.34)  # ~3 req/sec
            arxiv_id = result.entry_id.split("/abs/")[-1]
            papers.append({
                "paper_id": f"arxiv:{arxiv_id}",
                "title": result.title,
                "authors": [a.name for a in result.authors],
                "abstract": result.summary,
                "year": result.published.year if result.published else None,
                "doi": result.doi,
                "url": result.entry_id,
                "pdf_url": result.pdf_url,
                "source": "arxiv",
                "citation_count": 0,
                "full_text": None,
            })
    except Exception as e:
        print(f"  arXiv search error: {e}")
    return papers


def _search_semantic_scholar(topic: str, max_results: int, s2_api_key: str | None = None, year_min: int | None = None, year_max: int | None = None) -> list[dict]:
    """Search Semantic Scholar API and return paper metadata dicts."""
    papers = []
    try:
        _rate_limit("semantic_scholar", 1.0)
        url = "https://api.semanticscholar.org/graph/v1/paper/search"
        params = {
            "query": topic,
            "limit": min(max_results, 100),
            "fields": "paperId,title,authors,abstract,year,externalIds,url,citationCount,isOpenAccess,openAccessPdf",
        }
        # S2 supports year range filter: "year": "2017-2023" or "year": "2017-" or "year": "-2017"
        if year_min or year_max:
            params["year"] = f"{year_min or ''}-{year_max or ''}"
        headers = {}
        s2_key = s2_api_key or os.environ.get("S2_API_KEY")
        if s2_key:
            headers["x-api-key"] = s2_key
        resp = requests.get(url, params=params, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        for item in data.get("data", []):
            ext_ids = item.get("externalIds") or {}
            arxiv_id = ext_ids.get("ArXiv")
            doi = ext_ids.get("DOI")
            oa_pdf = item.get("openAccessPdf") or {}
            pdf_url = oa_pdf.get("url")

            # Build paper_id
            if arxiv_id:
                paper_id = f"arxiv:{arxiv_id}"
            elif doi:
                paper_id = f"doi:{doi}"
            else:
                paper_id = f"s2:{item.get('paperId', 'unknown')}"

            papers.append({
                "paper_id": paper_id,
                "title": item.get("title", ""),
                "authors": [a.get("name", "") for a in (item.get("authors") or [])],
                "abstract": item.get("abstract") or "",
                "year": item.get("year"),
                "doi": doi,
                "url": item.get("url", ""),
                "pdf_url": pdf_url,
                "source": "semantic_scholar",
                "citation_count": item.get("citationCount", 0) or 0,
                "full_text": None,
            })
    except Exception as e:
        print(f"  Semantic Scholar search error: {e}")
    return papers


def _search_openalex(topic: str, max_results: int, year_min: int | None = None, year_max: int | None = None) -> list[dict]:
    """Search OpenAlex API (free, no key required) and return paper metadata dicts."""
    papers = []
    try:
        _rate_limit("openalex", 0.1)
        url = "https://api.openalex.org/works"
        params = {
            "search": topic,
            "per_page": min(max_results, 200),
            "sort": "cited_by_count:desc",
            "mailto": "ouroboros@localhost",
        }
        # OpenAlex supports filter by publication_year range
        if year_min and year_max:
            params["filter"] = f"publication_year:{year_min}-{year_max}"
        elif year_min:
            params["filter"] = f"publication_year:>{year_min - 1}"
        elif year_max:
            params["filter"] = f"publication_year:<{year_max + 1}"
        resp = _get_session().get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        for item in data.get("results", []):
            doi = item.get("doi", "")
            if doi and doi.startswith("https://doi.org/"):
                doi = doi.removeprefix("https://doi.org/")

            # Extract abstract from inverted index if available
            abstract = ""
            abstract_idx = item.get("abstract_inverted_index")
            if abstract_idx:
                word_positions = []
                for word, positions in abstract_idx.items():
                    for pos in positions:
                        word_positions.append((pos, word))
                word_positions.sort()
                abstract = " ".join(w for _, w in word_positions)

            # Get best OA PDF URL
            pdf_url = None
            best_oa = item.get("best_oa_location") or {}
            if best_oa.get("pdf_url"):
                pdf_url = best_oa["pdf_url"]
            elif item.get("primary_location", {}).get("pdf_url"):
                pdf_url = item["primary_location"]["pdf_url"]

            authors = []
            for authorship in (item.get("authorships") or []):
                name = authorship.get("author", {}).get("display_name")
                if name:
                    authors.append(name)

            paper_id = f"doi:{doi}" if doi else f"openalex:{item.get('id', '').split('/')[-1]}"

            # Skip results without a PDF URL -- website-only entries aren't useful
            if not pdf_url:
                continue

            papers.append({
                "paper_id": paper_id,
                "title": item.get("display_name") or item.get("title") or "",
                "authors": authors,
                "abstract": abstract,
                "year": item.get("publication_year"),
                "doi": doi or None,
                "url": item.get("doi") or item.get("id", ""),
                "pdf_url": pdf_url,
                "source": "openalex",
                "citation_count": item.get("cited_by_count", 0) or 0,
                "full_text": None,
            })
    except Exception as e:
        print(f"  OpenAlex search error: {e}")
    return papers


def _search_core(topic: str, max_results: int, core_api_key: str | None = None) -> list[dict]:
    """Search CORE API (requires API key) and return paper metadata dicts."""
    key = core_api_key or os.environ.get("CORE_API_KEY")
    if not key:
        return []

    papers = []
    try:
        _rate_limit("core", 0.2)
        url = "https://api.core.ac.uk/v3/search/works"
        params = {
            "q": topic,
            "limit": min(max_results, 100),
        }
        headers = {"Authorization": f"Bearer {key}"}
        resp = _get_session().get(url, params=params, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        for item in data.get("results", []):
            doi = item.get("doi") or ""
            if doi.startswith("https://doi.org/"):
                doi = doi.removeprefix("https://doi.org/")

            pdf_url = item.get("downloadUrl") or item.get("sourceFulltextUrls", [None])[0] if item.get("sourceFulltextUrls") else None

            authors = []
            for author in (item.get("authors") or []):
                name = author.get("name") if isinstance(author, dict) else str(author)
                if name:
                    authors.append(name)

            paper_id = f"doi:{doi}" if doi else f"core:{item.get('id', 'unknown')}"

            papers.append({
                "paper_id": paper_id,
                "title": item.get("title") or "",
                "authors": authors,
                "abstract": item.get("abstract") or "",
                "year": item.get("yearPublished"),
                "doi": doi or None,
                "url": item.get("downloadUrl") or item.get("links", [{}])[0].get("url", "") if item.get("links") else "",
                "pdf_url": pdf_url,
                "source": "core",
                "citation_count": item.get("citationCount", 0) or 0,
                "full_text": item.get("fullText") or None,
            })
    except Exception as e:
        print(f"  CORE search error: {e}")
    return papers


def search_papers(
    topic: str,
    max_results: int = 20,
    s2_api_key: str | None = None,
    core_api_key: str | None = None,
    year_min: int | None = None,
    year_max: int | None = None,
    sources: list[str] | None = None,
) -> list[dict]:
    """Search arXiv + Semantic Scholar + OpenAlex + CORE, deduplicate, return merged results.

    Args:
        topic: Research topic query string.
        max_results: Max papers to return total.
        s2_api_key: Optional Semantic Scholar API key.
        core_api_key: Optional CORE API key.
        year_min: Only include papers published in or after this year.
        year_max: Only include papers published in or before this year.
        sources: List of sources to search (e.g. ["arxiv", "openalex"]).
                 If None, all sources are searched.

    Returns:
        List of paper metadata dicts, deduplicated by paper_id.
    """
    enabled = set(sources) if sources else {"arxiv", "semantic_scholar", "openalex", "core"}
    year_label = ""
    if year_min and year_max:
        year_label = f" ({year_min}-{year_max})"
    elif year_min:
        year_label = f" ({year_min}+)"
    elif year_max:
        year_label = f" (up to {year_max})"
    print(f"Searching for papers on: {topic}{year_label}")

    # Search enabled sources
    arxiv_papers = _search_arxiv(topic, max_results) if "arxiv" in enabled else []
    if "arxiv" in enabled:
        print(f"  arXiv: {len(arxiv_papers)} results")

    s2_papers = _search_semantic_scholar(topic, max_results, s2_api_key=s2_api_key, year_min=year_min, year_max=year_max) if "semantic_scholar" in enabled else []
    if "semantic_scholar" in enabled:
        print(f"  Semantic Scholar: {len(s2_papers)} results")

    openalex_papers = _search_openalex(topic, max_results, year_min=year_min, year_max=year_max) if "openalex" in enabled else []
    if "openalex" in enabled:
        print(f"  OpenAlex: {len(openalex_papers)} results")

    core_papers = _search_core(topic, max_results, core_api_key=core_api_key) if "core" in enabled else []
    if "core" in enabled:
        print(f"  CORE: {len(core_papers)} results")

    # Deduplicate -- prefer arXiv entries (they have direct PDF URLs)
    seen_ids = set()
    seen_titles = set()
    merged = []
    skipped_lang = 0
    skipped_year = 0

    for paper in arxiv_papers + s2_papers + openalex_papers + core_papers:
        pid = paper["paper_id"]
        title_key = paper["title"].lower().strip()

        if pid in seen_ids or title_key in seen_titles:
            continue

        # Filter non-English papers
        check_text = f"{paper.get('title', '')} {paper.get('abstract', '')}"
        if not _is_english(check_text):
            skipped_lang += 1
            continue

        # Filter by year range
        paper_year = paper.get("year")
        if paper_year:
            if year_min and paper_year < year_min:
                skipped_year += 1
                continue
            if year_max and paper_year > year_max:
                skipped_year += 1
                continue

        seen_ids.add(pid)
        seen_titles.add(title_key)
        merged.append(paper)

    # Sort by citation count descending
    merged.sort(key=lambda p: p["citation_count"], reverse=True)

    # Trim to max_results
    merged = merged[:max_results]
    print(f"  Merged (deduplicated): {len(merged)} papers")
    if skipped_lang:
        print(f"  Filtered out {skipped_lang} non-English papers")
    if skipped_year:
        print(f"  Filtered out {skipped_year} papers outside year range")
    return merged


# ── Full-text extraction ───────────────────────────────────────────────

def _fetch_pdf_text(pdf_url: str, paper_id: str = "") -> tuple[str | None, str | None]:
    """Download PDF, save to disk, extract text with PyMuPDF.

    Returns:
        Tuple of (extracted_text, pdf_path) where pdf_path is the saved file
        path relative to the project root, or None if download/extraction failed.
    """
    try:
        import pymupdf

        resp = _get_session().get(pdf_url, headers=_PDF_HEADERS, timeout=60, stream=True)
        resp.raise_for_status()

        raw_bytes = resp.content

        # Save PDF to data/pdfs/
        pdf_dir = Path(__file__).resolve().parent.parent / "data" / "pdfs"
        pdf_dir.mkdir(parents=True, exist_ok=True)
        safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', paper_id)[:100] if paper_id else "unknown"
        pdf_file = pdf_dir / f"{safe_name}.pdf"
        pdf_file.write_bytes(raw_bytes)
        pdf_path = str(pdf_file)

        pdf_bytes = io.BytesIO(raw_bytes)
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")

        text_parts = []
        for page in doc:
            text_parts.append(page.get_text())
        doc.close()

        full_text = "\n".join(text_parts).strip()
        if len(full_text) > 100:
            return full_text, pdf_path
        return None, pdf_path
    except Exception as e:
        print(f"    PDF extraction failed: {e}")
        return None, None


def _unpaywall_pdf_url(doi: str) -> str | None:
    """Try to find an open-access PDF via Unpaywall."""
    if not doi:
        return None
    try:
        url = f"https://api.unpaywall.org/v2/{doi}"
        params = {"email": "sdgs-tool@example.com"}
        resp = _get_session().get(url, params=params, headers=_PDF_HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        best_oa = data.get("best_oa_location") or {}
        return best_oa.get("url_for_pdf")
    except Exception:
        return None


def _pmc_pdf_url(doi: str) -> str | None:
    """Try to find an open-access PDF via PubMed Central (for biomedical papers)."""
    if not doi:
        return None
    try:
        # Step 1: DOI → PMCID via NCBI ID Converter
        conv_url = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/"
        conv_params = {"ids": doi, "format": "json"}
        resp = _get_session().get(conv_url, params=conv_params, headers=_PDF_HEADERS, timeout=15)
        resp.raise_for_status()
        records = resp.json().get("records", [])
        if not records:
            return None
        pmcid = records[0].get("pmcid")
        if not pmcid:
            return None

        # Step 2: PMCID → PDF link via OA service
        oa_url = "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi"
        oa_params = {"id": pmcid}
        resp = _get_session().get(oa_url, params=oa_params, headers=_PDF_HEADERS, timeout=15)
        resp.raise_for_status()

        root = ET.fromstring(resp.text)
        for link in root.iter("link"):
            href = link.get("href", "")
            fmt = link.get("format", "")
            if fmt == "pdf" or href.endswith(".pdf"):
                # Convert FTP URLs to HTTPS
                if href.startswith("ftp://"):
                    href = href.replace("ftp://ftp.ncbi.nlm.nih.gov/pub/pmc/", "https://pmc.ncbi.nlm.nih.gov/articles/", 1)
                return href
        return None
    except Exception:
        return None


def fetch_full_text(paper: dict) -> str | None:
    """Fetch full text for a paper via multi-level fallback chain.

    Also sets paper["pdf_path"] if a PDF is successfully saved to disk.

    Fallback chain:
        1. Direct pdf_url (from search metadata)
        2. arXiv canonical PDF (if paper_id starts with "arxiv:")
        3. PubMed Central (if paper has DOI)
        4. Unpaywall (if paper has DOI)

    Args:
        paper: Paper metadata dict (modified in-place with pdf_path).

    Returns:
        Extracted text string, or None if unavailable.
    """
    title_short = paper["title"][:60]
    paper_id = paper.get("paper_id", "")
    tried_urls: set[str] = set()

    def _try_url(url: str) -> str | None:
        if not url or url in tried_urls:
            return None
        tried_urls.add(url)
        text, pdf_path = _fetch_pdf_text(url, paper_id)
        if pdf_path:
            paper["pdf_path"] = pdf_path
        return text

    # 1. Direct PDF URL from search metadata
    if paper.get("pdf_url"):
        print(f"    Fetching PDF: {title_short}...")
        text = _try_url(paper["pdf_url"])
        if text:
            return text

    # 2. arXiv canonical PDF fallback
    if paper_id.startswith("arxiv:"):
        arxiv_id = paper_id.removeprefix("arxiv:")
        arxiv_pdf = f"https://arxiv.org/pdf/{arxiv_id}"
        if arxiv_pdf not in tried_urls:
            print(f"    Trying arXiv PDF fallback: {title_short}...")
            _rate_limit("arxiv", 0.34)
            text = _try_url(arxiv_pdf)
            if text:
                return text

    # 3. PubMed Central fallback (biomedical papers)
    if paper.get("doi"):
        print(f"    Trying PMC for: {title_short}...")
        pmc_url = _pmc_pdf_url(paper["doi"])
        if pmc_url:
            text = _try_url(pmc_url)
            if text:
                return text

    # 4. Unpaywall fallback
    if paper.get("doi"):
        print(f"    Trying Unpaywall for: {title_short}...")
        oa_url = _unpaywall_pdf_url(paper["doi"])
        if oa_url:
            text = _try_url(oa_url)
            if text:
                return text

    return None


# ── Text chunking for long papers ──────────────────────────────────────

def _last_n_sentences(text: str, n: int = 2) -> str:
    """Extract the last *n* complete sentences from text."""
    sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text.strip())
    if len(sentences) <= n:
        return text.strip()
    return ' '.join(sentences[-n:])


def _chunk_text(text: str, chunk_size: int = 10000) -> list[str]:
    """Split text into chunks at semantic boundaries (paragraph/section breaks).

    Uses paragraph splits and looks for section headers near boundaries.
    Overlap is done by including the last 2 complete sentences from the
    previous chunk rather than a fixed character count.
    """
    paragraphs = text.split('\n\n')
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    prev_tail = ""  # last 2 sentences from previous chunk for overlap

    for para in paragraphs:
        if current_len + len(para) > chunk_size and current:
            chunk_text = prev_tail + '\n\n'.join(current)
            chunks.append(chunk_text)
            # Extract last 2 sentences for overlap context
            prev_tail = _last_n_sentences('\n\n'.join(current), n=2) + '\n\n'
            current = [para]
            current_len = len(para)
        else:
            current.append(para)
            current_len += len(para) + 2

    if current:
        chunks.append(prev_tail + '\n\n'.join(current))
    return chunks


# ── Q&A generation from papers ─────────────────────────────────────────

def _parse_qa_pairs(content: str, paper: dict) -> list[dict]:
    """Parse <qa> blocks from LLM output into JSONL-compatible dicts."""
    pairs = []
    qa_blocks = re.findall(
        r"<qa>(.*?)</qa>", content, re.DOTALL | re.IGNORECASE
    )

    for block in qa_blocks:
        q_match = re.search(
            r"<question>(.*?)</question>", block, re.DOTALL | re.IGNORECASE
        )
        think_match = re.search(
            r"<think>(.*?)</think>", block, re.DOTALL | re.IGNORECASE
        )
        a_match = re.search(
            r"<answer>(.*?)</answer>", block, re.DOTALL | re.IGNORECASE
        )

        if q_match and a_match:
            think_text = think_match.group(1).strip() if think_match else ""
            answer_text = a_match.group(1).strip()

            output_text = ""
            if think_text:
                output_text += f"<think>{think_text}</think>\n"
            output_text += f"<answer>{answer_text}</answer>"

            entry = {
                "instruction": q_match.group(1).strip(),
                "output": output_text,
                "valid": True,
                "source_paper": paper["paper_id"],
                "source_title": paper["title"],
                "authors": paper.get("authors", []),
                "year": paper.get("year"),
                "abstract": paper.get("abstract", ""),
                "url": paper.get("url", ""),
                "doi": paper.get("doi"),
                "source": paper.get("source", ""),
                "citation_count": paper.get("citation_count", 0),
            }
            if paper.get("pdf_path"):
                entry["pdf_path"] = paper["pdf_path"]
            pairs.append(entry)

    return pairs


def _make_qa_call(
    client,
    model: str,
    api_params: dict,
    system_prompt: str,
    user_msg: str,
    temperature: float,
    max_tokens: int,
    max_retries: int,
    paper: dict,
    token_tracker: TokenTracker | None = None,
    cancel_event=None,
) -> list[dict]:
    """Make a single LLM call to generate Q&A pairs and parse the result."""
    for attempt in range(1, max_retries + 1):
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("Job cancelled")

        try:
            kwargs = dict(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_msg},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
            )
            if api_params:
                kwargs["extra_body"] = api_params

            response = client.chat.completions.create(**kwargs)

            if cancel_event and cancel_event.is_set():
                raise RuntimeError("Job cancelled")

            if token_tracker and hasattr(response, "usage"):
                token_tracker.update(response.usage)

            result = response.choices[0].message.content
            pairs = _parse_qa_pairs(result, paper)

            if pairs:
                return pairs

            if attempt < max_retries:
                print(f"    Retry {attempt}: no valid Q&A pairs parsed")
                time.sleep(1)

        except Exception as e:
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("Job cancelled")
            print(f"    Attempt {attempt} error: {e}")
            if attempt < max_retries:
                time.sleep(2)

    return []


def generate_qa_for_paper(
    client,
    model: str,
    extra_params: dict,
    task_config: dict,
    paper: dict,
    token_tracker: TokenTracker | None = None,
    max_tokens: int = 8192,
    cancel_event=None,
) -> list[dict]:
    """Generate Q&A pairs for a single paper using the LLM.

    For long papers (>12K chars), splits into ~10K chunks and makes one
    LLM call per chunk. For shorter content, makes a single call with a
    dynamic pair count based on content length.

    Args:
        client: OpenAI-compatible client.
        model: Model name.
        extra_params: Provider-specific params.
        task_config: Task YAML config.
        paper: Paper metadata dict with full_text or abstract.
        token_tracker: Optional tracker to accumulate usage.
        max_tokens: Max tokens for LLM response (default 8192).
        cancel_event: threading.Event set when job is cancelled.

    Returns:
        List of Q&A dicts.
    """
    gen_config = task_config["generation"]
    system_prompt = gen_config["system_prompt"]
    user_template = gen_config["user_prompt_template"]
    temperature = gen_config.get("temperature", 0.5)
    max_retries = gen_config.get("max_retries", 2)

    content = paper.get("full_text") or paper.get("abstract") or ""
    if not content:
        return []

    authors_str = ", ".join(paper.get("authors", [])[:5])
    api_params = {k: v for k, v in extra_params.items() if not k.startswith("_")}

    # ── Chunked generation for long papers ──
    if len(content) > 12000:
        chunks = _chunk_text(content, chunk_size=10000)
        print(f"    Splitting into {len(chunks)} chunks for generation")
        all_pairs: list[dict] = []

        for i, chunk in enumerate(chunks):
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("Job cancelled")

            count_hint = (
                f"\n\nGenerate 3-4 Q&A pairs from this section "
                f"(section {i + 1}/{len(chunks)} of the paper)."
            )
            chunk_system = system_prompt + count_hint

            user_msg = user_template.format(
                title=paper["title"],
                authors=authors_str,
                content=chunk,
            )

            pairs = _make_qa_call(
                client, model, api_params, chunk_system, user_msg,
                temperature, max_tokens, max_retries, paper, token_tracker,
                cancel_event=cancel_event,
            )
            all_pairs.extend(pairs)
            if pairs:
                print(f"    Chunk {i + 1}/{len(chunks)}: {len(pairs)} pairs")
            else:
                print(f"    Chunk {i + 1}/{len(chunks)}: 0 pairs")

        return all_pairs

    # ── Single call for shorter content with dynamic count ──
    content_len = len(content)
    if content_len < 2000:
        count_hint = "\n\nGenerate 3-5 Q&A pairs from this content."
    else:
        count_hint = "\n\nGenerate 6-8 Q&A pairs from this content."

    adjusted_system = system_prompt + count_hint

    user_msg = user_template.format(
        title=paper["title"],
        authors=authors_str,
        content=content,
    )

    return _make_qa_call(
        client, model, api_params, adjusted_system, user_msg,
        temperature, max_tokens, max_retries, paper, token_tracker,
        cancel_event=cancel_event,
    )


# ── Pipeline orchestrator ──────────────────────────────────────────────

def run_scrape(
    topic: str,
    provider: str | None,
    model: str | None,
    api_key: str | None,
    task_name: str,
    max_papers: int,
    top_n: int,
    output_path: str,
    collect_only: bool = False,
    system_prompt: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    cancel_event=None,
    s2_api_key: str | None = None,
    core_api_key: str | None = None,
    pre_papers: list[dict] | None = None,
):
    """Orchestrate the full scrape pipeline.

    1. Search for papers (arXiv + Semantic Scholar + OpenAlex + CORE)
    2. Rank by citation count
    3. Fetch full text for top N
    4. Generate Q&A pairs via LLM
    5. Write JSONL + citations.json

    Args:
        topic: Research topic to search.
        provider: LLM provider name (required unless collect_only).
        model: Model override.
        api_key: API key override.
        task_name: Task config name for generation prompts.
        max_papers: Max papers to search for.
        top_n: Fetch full text for top N papers.
        output_path: Output file path.
        collect_only: If True, just save paper metadata.
    """
    # ── Step 1: Search (skip if pre-fetched papers provided) ──
    if pre_papers:
        papers = pre_papers
        print(f"Using {len(papers)} pre-fetched papers from local database")
    else:
        papers = search_papers(topic, max_results=max_papers, s2_api_key=s2_api_key, core_api_key=core_api_key)

    if not papers:
        raise RuntimeError(f"No papers found for topic '{topic}'. APIs may be rate-limited — check arXiv and Semantic Scholar access.")

    # ── Collect-only mode ──
    if collect_only:
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        # Strip full_text from output (it's None anyway at this point)
        save_data = []
        for p in papers:
            entry = {k: v for k, v in p.items() if k != "full_text"}
            save_data.append(entry)
        with open(output, "w") as f:
            json.dump(save_data, f, indent=2)
        print(f"\nCollected {len(papers)} papers → {output_path}")
        return

    # ── Step 2: Fetch full text for top N ──
    print(f"\nFetching full text for top {top_n} papers...")
    full_text_count = 0
    for i, paper in enumerate(papers[:top_n]):
        text = fetch_full_text(paper)
        if text:
            paper["full_text"] = text
            full_text_count += 1
            print(f"  [{i+1}/{top_n}] Full text: {paper['title'][:50]}... ({len(text):,} chars)")
        else:
            print(f"  [{i+1}/{top_n}] Abstract only: {paper['title'][:50]}...")

    print(f"\nFull text obtained for {full_text_count}/{top_n} papers")
    # Prefer full-text papers, fall back to abstract-only if none have full text
    papers_with_full_text = [p for p in papers if p.get("full_text")]
    papers_with_abstract = [p for p in papers if p.get("abstract") and not p.get("full_text")]
    print(f"Papers with full text: {len(papers_with_full_text)}, abstract-only: {len(papers_with_abstract)}")

    if papers_with_full_text:
        papers_with_content = papers_with_full_text
    elif papers_with_abstract:
        print("No full text available -- falling back to abstract-only papers")
        for p in papers_with_abstract:
            p["full_text"] = p["abstract"]
        papers_with_content = papers_with_abstract
    else:
        raise RuntimeError("No papers with extractable content (no abstracts or full text available).")

    # ── Step 3: Setup LLM client ──
    from .providers import get_client

    # Load task config -- resolve from project root (2 levels up from sdgs/)
    _project_root = Path(__file__).resolve().parent.parent
    task_config_path = _project_root / "configs" / "tasks" / f"{task_name}.yaml"
    if not task_config_path.exists():
        available = ", ".join(
            sorted(p.stem for p in (_project_root / "configs" / "tasks").glob("*.yaml"))
        )
        print(f"Unknown task: '{task_name}'. Available: {available}")
        return

    import yaml
    with open(task_config_path) as f:
        task_config = yaml.safe_load(f)

    # Apply user overrides from web UI
    if system_prompt:
        task_config["generation"]["system_prompt"] = system_prompt
    if temperature is not None:
        task_config["generation"]["temperature"] = temperature

    effective_max_tokens = max_tokens if max_tokens is not None else 8192

    client, model_name, extra_params = get_client(provider, model=model, api_key=api_key)
    rate_delay = extra_params.get("_rate_limit_delay", 0)

    # Register client so cancel_job() can close it to abort in-flight requests
    try:
        from .web.services.job_runner import register_job_client
        # dataset_id is encoded in the output_path filename: {topic}_{dataset_id}.jsonl
        _ds_id_match = re.search(r'_(\d+)\.jsonl$', output_path)
        if _ds_id_match:
            register_job_client(int(_ds_id_match.group(1)), client)
    except ImportError:
        pass  # CLI usage without web server

    print(f"\nProvider: {provider} | Model: {model_name}")
    print(f"Generating Q&A from {len(papers_with_content)} papers...")
    print("=" * 60)

    # ── Step 4: Generate Q&A ──
    token_tracker = TokenTracker()
    gpu_tracker = GPUTracker()
    gpu_tracker.start()

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    all_pairs = []
    citations = []

    for i, paper in enumerate(papers_with_content):
        if cancel_event and cancel_event.is_set():
            print("\nJob cancelled by user")
            break

        title_short = paper["title"][:60]
        content_type = "full text" if paper.get("full_text") else "abstract"
        print(f"\n[{i+1}/{len(papers_with_content)}] {title_short}... ({content_type})")

        pairs = generate_qa_for_paper(
            client, model_name, extra_params, task_config, paper, token_tracker,
            max_tokens=effective_max_tokens,
            cancel_event=cancel_event,
        )

        if pairs:
            all_pairs.extend(pairs)
            print(f"  → {len(pairs)} Q&A pairs generated")
        else:
            print(f"  → No Q&A pairs generated")

        citations.append({
            "paper_id": paper["paper_id"],
            "title": paper["title"],
            "authors": paper.get("authors", []),
            "year": paper.get("year"),
            "doi": paper.get("doi"),
            "url": paper.get("url", ""),
            "source": paper.get("source", ""),
            "qa_pairs_generated": len(pairs),
        })

        if rate_delay > 0:
            time.sleep(rate_delay)

    gpu_tracker.stop()

    # ── Step 5: Write output ──
    with open(output_file, "w") as f:
        for pair in all_pairs:
            f.write(json.dumps(pair) + "\n")

    citations_path = output_file.parent / "citations.json"
    with open(citations_path, "w") as f:
        json.dump(citations, f, indent=2)

    # ── Summary ──
    print("\n" + "=" * 60)
    print("SCRAPE COMPLETE")
    print("=" * 60)
    print(f"Papers searched:     {len(papers)}")
    print(f"Papers with content: {len(papers_with_content)}")
    print(f"Full text fetched:   {full_text_count}")
    print(f"Q&A pairs generated: {len(all_pairs)}")
    print(f"Output:              {output_path}")
    print(f"Citations:           {citations_path}")

    token_tracker.report()
    gpu_tracker.report()
