"""
Knowledge base service: ChromaDB vector store with MiniLM-L6-v2 embeddings.

Follows the same pattern as the Nemotron-3-Nano RAG pipeline:
- MD5 hash-based duplicate detection (skip already-indexed files)
- RecursiveCharacterTextSplitter for chunking
- ChromaDB for vector storage with file-based persistence
- Batch insertion with progress tracking
"""
import hashlib
import json
import os
import queue
import threading
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from ..config import BASE_DIR

# --- Configuration (mirrors Nemotron settings.py) ---

EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200
COLLECTION_NAME = "ouroboros_papers"
TOP_K_RESULTS = 5
VECTOR_STORE_DIR = BASE_DIR / "data" / "vectorstore" / "chroma_db"
PDF_DIR = BASE_DIR / "data" / "pdfs"

# Ensure directories exist
VECTOR_STORE_DIR.mkdir(parents=True, exist_ok=True)


# --- Singleton embedding model (expensive to load, reuse across requests) ---

_embeddings: Optional[HuggingFaceEmbeddings] = None


def get_embeddings() -> HuggingFaceEmbeddings:
    """Get or create the embedding model (singleton)."""
    global _embeddings
    if _embeddings is None:
        _embeddings = HuggingFaceEmbeddings(model_name=EMBEDDING_MODEL)
    return _embeddings


# --- PDF chunking (follows pdf_chunker.py pattern) ---

def extract_and_chunk_pdf(pdf_path: str) -> list:
    """Extract text from a PDF and chunk it.

    Same approach as the Nemotron pipeline:
    - PyMuPDF for text extraction
    - RecursiveCharacterTextSplitter for chunking
    - Metadata tagging with source_file
    """
    try:
        text = ""
        with fitz.open(pdf_path) as doc:
            for page in doc:
                text += page.get_text() + "\n"

        if not text.strip():
            return []

        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=CHUNK_SIZE,
            chunk_overlap=CHUNK_OVERLAP,
            length_function=len,
        )
        chunks = text_splitter.create_documents([text])

        for chunk in chunks:
            chunk.metadata["source_file"] = os.path.basename(pdf_path)

        return chunks
    except Exception as e:
        print(f"Error processing {pdf_path}: {e}")
        return []


# --- Vector Store Manager (follows vector_store.py pattern) ---

class VectorStoreManager:
    """Manages ChromaDB vector store with file-level dedup tracking."""

    def __init__(self):
        self.embeddings = get_embeddings()
        self.vector_store: Optional[Chroma] = None
        self.index_log_path = VECTOR_STORE_DIR / "indexed_files.json"
        self.indexed_files = self._load_index_log()

    def _load_index_log(self) -> dict:
        if self.index_log_path.exists():
            with open(self.index_log_path, "r") as f:
                return json.load(f)
        return {}

    def _save_index_log(self):
        self.index_log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.index_log_path, "w") as f:
            json.dump(self.indexed_files, f, indent=2)

    def _file_hash(self, filepath: str) -> str:
        hash_md5 = hashlib.md5()
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()

    def is_file_indexed(self, pdf_path: str) -> bool:
        filename = Path(pdf_path).name
        if filename not in self.indexed_files:
            return False
        current_hash = self._file_hash(pdf_path)
        return self.indexed_files[filename] == current_hash

    def mark_file_indexed(self, pdf_path: str):
        filename = Path(pdf_path).name
        self.indexed_files[filename] = self._file_hash(pdf_path)
        self._save_index_log()

    def create_or_load(self) -> Chroma:
        if self.vector_store is None:
            self.vector_store = Chroma(
                collection_name=COLLECTION_NAME,
                embedding_function=self.embeddings,
                persist_directory=str(VECTOR_STORE_DIR),
            )
        return self.vector_store

    def add_documents(self, chunks: list, source_file: str | None = None, batch_size: int = 100) -> list:
        if not self.vector_store:
            self.create_or_load()

        all_ids = []
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i:i + batch_size]
            ids = self.vector_store.add_documents(batch)
            all_ids.extend(ids)

        if source_file:
            self.mark_file_indexed(source_file)

        return all_ids

    def similarity_search(self, query: str, k: int = TOP_K_RESULTS) -> list:
        if not self.vector_store:
            self.create_or_load()
        return self.vector_store.similarity_search(query, k=k)

    def get_collection_count(self) -> int:
        if not self.vector_store:
            self.create_or_load()
        return self.vector_store._collection.count()

    def delete_collection(self):
        if self.vector_store:
            self.vector_store.delete_collection()
            self.vector_store = None
        self.indexed_files = {}
        self._save_index_log()

    def list_indexed_files(self) -> list[str]:
        return list(self.indexed_files.keys())


# --- Module-level singleton ---

_manager: Optional[VectorStoreManager] = None


def get_manager() -> VectorStoreManager:
    global _manager
    if _manager is None:
        _manager = VectorStoreManager()
        _manager.create_or_load()
    return _manager


# --- High-level operations ---

def index_papers(force: bool = False) -> dict:
    """Index all PDFs (non-streaming). Returns final stats."""
    results = {}
    for event in index_papers_stream(force=force):
        if event.get("type") == "done":
            results = event
    return results


def index_papers_stream(force: bool = False):
    """Index all PDFs in data/pdfs/ into ChromaDB, yielding progress events.

    Follows the Nemotron pipeline: hash each file, skip duplicates,
    chunk new/changed files, embed and store.

    Yields dicts with type: log|skip|index|done.
    """
    manager = get_manager()

    pdf_files = sorted(PDF_DIR.glob("*.pdf"))
    total = len(pdf_files)

    if not pdf_files:
        yield {"type": "log", "message": "No PDFs found in data/pdfs/"}
        yield {"type": "done", "total_pdfs": 0, "indexed": 0, "skipped": 0, "chunks_added": 0}
        return

    yield {"type": "log", "message": f"Found {total} PDF(s) in data/pdfs/"}
    yield {"type": "log", "message": f"Embedding model: {EMBEDDING_MODEL}"}
    yield {"type": "log", "message": f"Chunk size: {CHUNK_SIZE}, overlap: {CHUNK_OVERLAP}"}
    yield {"type": "log", "message": "---"}

    indexed = 0
    skipped = 0
    total_chunks = 0

    for i, pdf_path in enumerate(pdf_files, 1):
        pdf_str = str(pdf_path)
        filename = pdf_path.name

        # Hash-based duplicate check
        if not force and manager.is_file_indexed(pdf_str):
            skipped += 1
            yield {"type": "skip", "message": f"[{i}/{total}] SKIP  {filename} (already indexed)", "file": filename, "progress": i, "total": total}
            continue

        yield {"type": "log", "message": f"[{i}/{total}] Extracting text from {filename}..."}

        chunks = extract_and_chunk_pdf(pdf_str)
        if chunks:
            yield {"type": "log", "message": f"[{i}/{total}] Chunked into {len(chunks)} segments, embedding..."}
            manager.add_documents(chunks, source_file=pdf_str)
            total_chunks += len(chunks)
            indexed += 1
            yield {"type": "index", "message": f"[{i}/{total}] OK    {filename} -> {len(chunks)} chunks", "file": filename, "chunks": len(chunks), "progress": i, "total": total}
        else:
            skipped += 1
            yield {"type": "skip", "message": f"[{i}/{total}] SKIP  {filename} (no text extracted)", "file": filename, "progress": i, "total": total}

    yield {"type": "log", "message": "---"}
    yield {"type": "log", "message": f"Done. Indexed {indexed}, skipped {skipped}, {total_chunks} total chunks."}
    yield {"type": "done", "total_pdfs": total, "indexed": indexed, "skipped": skipped, "chunks_added": total_chunks}


def search(query: str, k: int = TOP_K_RESULTS) -> list[dict]:
    """Semantic similarity search across indexed papers."""
    manager = get_manager()
    docs = manager.similarity_search(query, k=k)
    return [
        {
            "content": doc.page_content,
            "source_file": doc.metadata.get("source_file", "unknown"),
            "metadata": doc.metadata,
        }
        for doc in docs
    ]


def chat(query: str, model: str = "gpt-oss:120b", k: int = TOP_K_RESULTS, temperature: float = 0.7, top_k: int = 40, max_tokens: int = 2048) -> dict:
    """RAG chat: retrieve context from knowledge base, generate answer with Ollama.

    - Similarity search for relevant chunks
    - Build context string with source attribution
    - Prompt Ollama with context + question
    """
    from langchain_ollama import OllamaLLM

    manager = get_manager()
    docs = manager.similarity_search(query, k=k)

    if not docs:
        return {
            "answer": "No relevant documents found in the knowledge base.",
            "sources": [],
            "chunks_used": 0,
            "model": model,
        }

    # Build context from retrieved chunks
    context = "\n\n".join([
        f"[Source: {doc.metadata.get('source_file', 'unknown')}]\n{doc.page_content}"
        for doc in docs
    ])

    prompt = f"""You are a technical documentation expert. Using the context provided below, give a comprehensive and detailed answer to the question.

Instructions:
- Provide a thorough explanation with relevant details
- Include specific examples or technical specifications when available
- Structure your response with clear paragraphs
- If context is insufficient, explain what information is missing

Context:
{context}

Question: {query}

Answer:"""

    llm = OllamaLLM(
        model=model,
        base_url="http://localhost:11434",
        temperature=temperature,
        top_k=top_k,
        num_predict=max_tokens,
    )

    response = llm.invoke(prompt)

    sources = list(set([
        doc.metadata.get("source_file", "unknown") for doc in docs
    ]))

    return {
        "answer": response.strip(),
        "sources": sources,
        "chunks_used": len(docs),
        "model": model,
    }


def get_status() -> dict:
    """Get knowledge base status: indexed file count, chunk count, etc."""
    manager = get_manager()
    return {
        "collection_count": manager.get_collection_count(),
        "indexed_files": manager.list_indexed_files(),
        "indexed_file_count": len(manager.indexed_files),
        "total_pdfs": len(list(PDF_DIR.glob("*.pdf"))),
        "vector_store_dir": str(VECTOR_STORE_DIR),
    }


def reset():
    """Delete the entire vector store and index log."""
    global _manager
    manager = get_manager()
    manager.delete_collection()
    _manager = None


# --- Background indexing with persistent log buffer ---

_index_lock = threading.Lock()
_index_queue: Optional[queue.Queue] = None
_index_logs: list[dict] = []
_index_running = False
_index_cancel = threading.Event()


def _emit_index(item: dict):
    """Append to persistent log buffer and push to the live queue."""
    global _index_queue
    with _index_lock:
        _index_logs.append(item)
        if _index_queue is not None:
            _index_queue.put(item)


def _index_worker(force: bool):
    """Run indexing in a background thread, emitting events to the log buffer."""
    global _index_running
    try:
        for event in index_papers_stream(force=force):
            if _index_cancel.is_set():
                _emit_index({"type": "log", "message": "Indexing cancelled by user."})
                _emit_index({"type": "done", "message": "Cancelled", "total_pdfs": 0, "indexed": 0, "skipped": 0, "chunks_added": 0})
                return
            _emit_index(event)
    except Exception as e:
        _emit_index({"type": "done", "message": f"Error: {e}", "total_pdfs": 0, "indexed": 0, "skipped": 0, "chunks_added": 0})
    finally:
        with _index_lock:
            _index_running = False
            _index_cancel.clear()
            if _index_queue is not None:
                _index_queue.put(None)  # sentinel


def start_indexing(force: bool = False) -> bool:
    """Start background indexing. Returns False if already running."""
    global _index_queue, _index_logs, _index_running
    with _index_lock:
        if _index_running:
            return False
        _index_running = True
        _index_cancel.clear()
        _index_queue = queue.Queue()
        _index_logs.clear()
    t = threading.Thread(target=_index_worker, args=(force,), daemon=True)
    t.start()
    return True


def stop_indexing() -> bool:
    """Cancel a running indexing operation."""
    with _index_lock:
        if not _index_running:
            return False
    _index_cancel.set()
    return True


def is_indexing() -> bool:
    with _index_lock:
        return _index_running


def get_index_queue() -> Optional[queue.Queue]:
    with _index_lock:
        if _index_running:
            return _index_queue
        return None


def get_index_logs() -> list[dict]:
    with _index_lock:
        return list(_index_logs)
