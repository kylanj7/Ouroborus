"""Galaxy graph construction service — builds nodes/links from datasets and papers."""
import math
import re
from collections import defaultdict

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db.models import Dataset, Paper, QAPair

STOP_WORDS = {
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
    "were", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "shall", "can",
    "this", "that", "these", "those", "not", "no", "its", "we", "our",
    "their", "using", "based", "via", "into", "over", "about", "between",
    "through", "during", "before", "after", "above", "below", "up", "down",
    "than", "other", "such", "only", "also", "more", "most", "very",
    "each", "every", "all", "both", "few", "many", "some", "any",
    "new", "first", "two", "one", "which", "when", "how", "what",
}

CLUSTER_COLORS = [
    "#7eb8ff", "#6ee7d8", "#ffd666", "#c084fc", "#ff7eb3",
    "#a3e635", "#fb923c", "#60a5fa", "#f472b6", "#34d399",
]


def extract_keywords(text: str, max_keywords: int = 10) -> list[str]:
    """Extract keywords from text via simple stop-word removal."""
    words = re.findall(r"[a-z]{3,}", text.lower())
    filtered = [w for w in words if w not in STOP_WORDS]
    # Count and return top keywords
    freq = defaultdict(int)
    for w in filtered:
        freq[w] += 1
    return [w for w, _ in sorted(freq.items(), key=lambda x: -x[1])[:max_keywords]]


def build_galaxy_data(db: Session, user_id: int) -> dict:
    """Build the galaxy graph from datasets and papers (QA pairs excluded for performance)."""
    datasets = (
        db.query(Dataset)
        .filter(Dataset.user_id == user_id, Dataset.status == "completed")
        .all()
    )
    papers = db.query(Paper).filter(Paper.user_id == user_id).all()

    if not datasets and not papers:
        return {"nodes": [], "links": [], "clusters": []}

    # ── Pre-build lookup dicts ──
    papers_by_dataset: dict[int, list] = defaultdict(list)
    for p in papers:
        if p.dataset_id:
            papers_by_dataset[p.dataset_id].append(p)

    # Get QA counts via aggregation (not loading all rows)
    qa_count_by_paper: dict[int, int] = defaultdict(int)
    qa_count_by_dataset: dict[int, int] = defaultdict(int)
    for paper_id, cnt in (
        db.query(QAPair.paper_id, func.count())
        .filter(QAPair.user_id == user_id, QAPair.paper_id.isnot(None))
        .group_by(QAPair.paper_id)
        .all()
    ):
        qa_count_by_paper[paper_id] = cnt
    for dataset_id, cnt in (
        db.query(QAPair.dataset_id, func.count())
        .filter(QAPair.user_id == user_id, QAPair.dataset_id.isnot(None))
        .group_by(QAPair.dataset_id)
        .all()
    ):
        qa_count_by_dataset[dataset_id] = cnt

    # Load a limited sample of QA pairs for graph nodes (not all)
    MAX_QA_PER_PARENT = 8
    MAX_QA_TOTAL = 2000
    paper_ids = [p.id for p in papers]
    dataset_ids = [ds.id for ds in datasets]

    qa_by_paper: dict[int, list] = defaultdict(list)
    qa_by_dataset_only: dict[int, list] = defaultdict(list)
    qa_total = 0

    if paper_ids:
        # Load sampled QA pairs for papers
        sampled_qa = (
            db.query(QAPair)
            .filter(QAPair.user_id == user_id, QAPair.paper_id.in_(paper_ids))
            .limit(MAX_QA_TOTAL)
            .all()
        )
        for qa in sampled_qa:
            if qa_total >= MAX_QA_TOTAL:
                break
            if len(qa_by_paper[qa.paper_id]) < MAX_QA_PER_PARENT:
                qa_by_paper[qa.paper_id].append(qa)
                qa_total += 1

    if dataset_ids and qa_total < MAX_QA_TOTAL:
        # Load sampled QA pairs for datasets (paper-less ones)
        sampled_ds_qa = (
            db.query(QAPair)
            .filter(
                QAPair.user_id == user_id,
                QAPair.paper_id.is_(None),
                QAPair.dataset_id.in_(dataset_ids),
            )
            .limit(MAX_QA_TOTAL - qa_total)
            .all()
        )
        for qa in sampled_ds_qa:
            if qa_total >= MAX_QA_TOTAL:
                break
            if len(qa_by_dataset_only[qa.dataset_id]) < MAX_QA_PER_PARENT:
                qa_by_dataset_only[qa.dataset_id].append(qa)
                qa_total += 1

    # Extract keywords and build paper keyword map
    paper_keywords: dict[int, list[str]] = {}
    for p in papers:
        text = f"{p.title or ''} {p.abstract or ''}"
        paper_keywords[p.id] = extract_keywords(text)

    # Use datasets as clusters (one cluster per dataset)
    cluster_infos = []
    paper_cluster: dict[int, int] = {}
    dataset_cluster: dict[int, int] = {}

    for i, ds in enumerate(datasets):
        color = CLUSTER_COLORS[i % len(CLUSTER_COLORS)]
        ds_papers = papers_by_dataset[ds.id]
        cluster_infos.append({
            "id": i,
            "label": ds.topic[:30] if ds.topic else f"Dataset {ds.id}",
            "color": color,
            "paper_count": len(ds_papers),
            "qa_pair_count": qa_count_by_dataset[ds.id],
        })
        dataset_cluster[ds.id] = i
        for p in ds_papers:
            paper_cluster[p.id] = i

    # Assign orphan papers (no dataset) to a misc cluster
    orphan_papers = [p for p in papers if p.id not in paper_cluster]
    if orphan_papers:
        misc_idx = len(cluster_infos)
        cluster_infos.append({
            "id": misc_idx,
            "label": "uncategorized",
            "color": "#888888",
            "paper_count": len(orphan_papers),
        })
        for p in orphan_papers:
            paper_cluster[p.id] = misc_idx

    # Build nodes
    nodes = []

    # Dataset nodes — large central hubs
    for ds in datasets:
        cid = dataset_cluster.get(ds.id, 0)
        color = cluster_infos[cid]["color"] if cid < len(cluster_infos) else "#7eb8ff"
        ds_qa_count = qa_count_by_dataset[ds.id]
        ds_paper_count = len(papers_by_dataset[ds.id])
        size = min(20, 12 + math.log2(ds_qa_count + 1) * 1.5)
        nodes.append({
            "id": f"dataset-{ds.id}",
            "type": "dataset",
            "label": ds.topic or ds.name,
            "size": round(size, 1),
            "color": color,
            "cluster": cid,
            "year": None,
            "citation_count": None,
            "abstract": f"{ds_paper_count} papers, {ds_qa_count} Q&A pairs | {ds.provider or 'unknown'}/{ds.model or 'default'}",
            "authors": None,
            "url": None,
            "qa_pair_count": ds_qa_count,
        })

    # Paper nodes — sized by QA count + citation count
    for p in papers:
        cid = paper_cluster.get(p.id, 0)
        color = cluster_infos[cid]["color"] if cid < len(cluster_infos) else "#7eb8ff"
        qa_count = qa_count_by_paper[p.id]
        size = 2.5 + math.log2(qa_count + 1) * 1.2 + math.log2((p.citation_count or 0) + 1) * 0.8
        nodes.append({
            "id": f"paper-{p.id}",
            "type": "paper",
            "label": p.title or "Untitled",
            "size": round(size, 1),
            "color": color,
            "cluster": cid,
            "year": p.year,
            "citation_count": p.citation_count or 0,
            "abstract": (p.abstract or "")[:300],
            "authors": p.authors or [],
            "url": p.url,
            "qa_pair_count": qa_count,
        })

    # QA nodes + links — capped per paper/dataset to keep graph manageable
    qa_links = []

    # QAs linked through papers
    for p in papers:
        cid = paper_cluster.get(p.id, 0)
        color = cluster_infos[cid]["color"] if cid < len(cluster_infos) else "#6ee7d8"
        for qa in qa_by_paper[p.id][:MAX_QA_PER_PARENT]:
            nodes.append({
                "id": f"qa-{qa.id}",
                "type": "qa",
                "label": (qa.instruction or "")[:50],
                "size": 2.5,
                "color": color,
                "cluster": cid,
                "instruction": qa.instruction,
                "answer_text": qa.answer_text or (qa.output or "")[:200],
                "is_valid": qa.is_valid,
            })
            qa_links.append({
                "source": f"paper-{p.id}",
                "target": f"qa-{qa.id}",
                "weight": 0.3,
                "type": "paper_qa",
            })

    # QAs linked directly to datasets (no paper, e.g. HF imports)
    for ds in datasets:
        cid = dataset_cluster.get(ds.id, 0)
        color = cluster_infos[cid]["color"] if cid < len(cluster_infos) else "#6ee7d8"
        for qa in qa_by_dataset_only[ds.id][:MAX_QA_PER_PARENT]:
            nodes.append({
                "id": f"qa-{qa.id}",
                "type": "qa",
                "label": (qa.instruction or "")[:50],
                "size": 2.5,
                "color": color,
                "cluster": cid,
                "instruction": qa.instruction,
                "answer_text": qa.answer_text or (qa.output or "")[:200],
                "is_valid": qa.is_valid,
            })
            qa_links.append({
                "source": f"dataset-{ds.id}",
                "target": f"qa-{qa.id}",
                "weight": 0.2,
                "type": "dataset_qa",
            })

    # Build links
    links = list(qa_links)

    # Dataset -> Paper links
    for p in papers:
        if p.dataset_id:
            links.append({
                "source": f"dataset-{p.dataset_id}",
                "target": f"paper-{p.id}",
                "weight": 0.5,
                "type": "dataset_paper",
            })

    # Shared keyword links between papers — inverted index approach (O(n*k) not O(n^2))
    keyword_to_papers: dict[str, list[int]] = defaultdict(list)
    for pid, kws in paper_keywords.items():
        for kw in kws:
            keyword_to_papers[kw].append(pid)

    pair_overlap: dict[tuple[int, int], int] = defaultdict(int)
    for _kw, pids in keyword_to_papers.items():
        if len(pids) > 50:
            continue  # skip overly common keywords
        for i in range(len(pids)):
            for j in range(i + 1, len(pids)):
                key = (min(pids[i], pids[j]), max(pids[i], pids[j]))
                pair_overlap[key] += 1

    for (p1_id, p2_id), overlap in pair_overlap.items():
        if overlap >= 3:
            links.append({
                "source": f"paper-{p1_id}",
                "target": f"paper-{p2_id}",
                "weight": overlap / 10,
                "type": "keyword",
            })

    return {
        "nodes": nodes,
        "links": links,
        "clusters": cluster_infos,
    }


def get_paper_detail(db: Session, paper_id: int, user_id: int) -> dict | None:
    """Get paper detail with its Q&A pairs, scoped to user."""
    paper = db.query(Paper).filter(Paper.id == paper_id, Paper.user_id == user_id).first()
    if not paper:
        return None

    qa_pairs = db.query(QAPair).filter(QAPair.paper_id == paper.id).all()

    return {
        "paper_id": paper.paper_id or str(paper.id),
        "title": paper.title,
        "authors": paper.authors or [],
        "abstract": paper.abstract,
        "year": paper.year,
        "citation_count": paper.citation_count or 0,
        "url": paper.url,
        "qa_pairs": [
            {
                "instruction": qa.instruction,
                "output": qa.output,
                "is_valid": qa.is_valid,
                "was_healed": qa.was_healed,
                "think_text": qa.think_text,
                "answer_text": qa.answer_text,
            }
            for qa in qa_pairs
        ],
    }
