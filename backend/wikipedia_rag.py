"""
backend/wikipedia_rag.py — Wikipedia RAG runtime for S.T.A.R.L.I.N.G.

Loads the Wikipedia ChromaDB collection at startup and serves article-scoped
Q&A sessions.  Public interface (identical across all phases):

  load_index()                         — call at FastAPI startup
  get_embed_model()                    — call at FastAPI startup (warm-up)
  start_wikipedia_session(query)       → WikipediaSession
  retrieve_chunks(query, top_k)        → list[str]
  build_wiki_system_prompt(excerpts)   → str
  get_session()                        → Optional[WikipediaSession]
  clear_session()
  get_wiki_status()                    → dict  (for /wiki/status)

ChromaDB collection: 'wikipedia_articles' (separate from 'starling_docs').
Embedding model: nomic-ai/nomic-embed-text-v1 via sentence-transformers.
Requires the index to be built first with: python scripts/ingest_wikipedia.py
"""

from __future__ import annotations

import logging
import os
import time
from collections import Counter
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
CHROMA_PATH      = os.getenv("WIKI_CHROMA_PATH", str(Path(__file__).parent / "memory" / "chroma_db"))
WIKI_COLLECTION  = "wikipedia_articles"
EMBEDDING_MODEL  = "nomic-ai/nomic-embed-text-v1"
EMBEDDING_DEVICE = os.getenv("WIKI_EMBED_DEVICE", "cuda")
TOP_K_DEFAULT    = int(os.getenv("WIKI_TOP_K", "4"))

# nomic-embed-text asymmetric retrieval prefixes
QUERY_PREFIX    = "search_query: "
DOCUMENT_PREFIX = "search_document: "


# ── Embedding model singleton ──────────────────────────────────────────────────
_embed_model = None


def get_embed_model():
    """Lazy-load the nomic-embed-text model and cache it for the process lifetime."""
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer
        logger.info(
            f"Wikipedia: loading embedding model '{EMBEDDING_MODEL}' on {EMBEDDING_DEVICE}"
        )
        _embed_model = SentenceTransformer(
            EMBEDDING_MODEL,
            device=EMBEDDING_DEVICE,
            trust_remote_code=True,
        )
        logger.info("Wikipedia: embedding model ready.")
    return _embed_model


def _embed_query(text: str) -> list[float]:
    """Embed a search query with the nomic query prefix."""
    model = get_embed_model()
    return model.encode(
        [QUERY_PREFIX + text],
        normalize_embeddings=True,
    ).tolist()[0]


# ── ChromaDB ───────────────────────────────────────────────────────────────────
_chroma_client   = None
_wiki_collection = None


def _get_collection():
    global _chroma_client, _wiki_collection
    if _wiki_collection is not None:
        return _wiki_collection
    import chromadb
    _chroma_client  = chromadb.PersistentClient(path=CHROMA_PATH)
    _wiki_collection = _chroma_client.get_or_create_collection(
        WIKI_COLLECTION,
        metadata={"hnsw:space": "cosine"},
    )
    return _wiki_collection


def load_index():
    """
    Pre-load the ChromaDB collection and embedding model at FastAPI startup.
    Safe to call before any ingestion — the collection will simply be empty.
    """
    try:
        col   = _get_collection()
        count = col.count()
        if count == 0:
            logger.info(
                "Wikipedia: index is empty — run 'python scripts/ingest_wikipedia.py' "
                "to build it before using the Wikipedia trigger."
            )
        else:
            logger.info(f"Wikipedia: index ready — {count:,} chunks in '{WIKI_COLLECTION}'")
    except Exception as exc:
        logger.warning(f"Wikipedia: could not load index — {exc}")


# ── Article discovery ──────────────────────────────────────────────────────────

def find_article(query: str) -> Optional[str]:
    """
    Find the best-matching Wikipedia article title for a user query.

    Embeds the query, retrieves the top-20 semantically similar chunks,
    and returns the article title that appears most frequently (majority vote).
    Returns None when the index is empty or no match is found.
    """
    col = _get_collection()
    total = col.count()
    if total == 0:
        return None

    embedding = _embed_query(query)
    n_results = min(20, total)

    results = col.query(
        query_embeddings=[embedding],
        n_results=n_results,
        include=["metadatas"],
    )

    if not results["metadatas"] or not results["metadatas"][0]:
        return None

    titles = [m["title"] for m in results["metadatas"][0] if "title" in m]
    if not titles:
        return None

    return Counter(titles).most_common(1)[0][0]


# ── Session state ──────────────────────────────────────────────────────────────

@dataclass
class WikipediaSession:
    article_title: str
    chunk_count:   int
    created_at:    float = field(default_factory=time.time)

    def to_status(self) -> dict:
        return {
            "active":      True,
            "title":       self.article_title,
            "chunk_count": self.chunk_count,
            "created_at":  self.created_at,
        }


_current_session: Optional[WikipediaSession] = None


def get_session() -> Optional[WikipediaSession]:
    return _current_session


def clear_session() -> None:
    global _current_session
    _current_session = None


def start_wikipedia_session(query: str) -> WikipediaSession:
    """
    Find the closest article in the index, start a session scoped to it,
    and return it.  Raises ValueError if the index is empty or no match is found.
    """
    global _current_session

    title = find_article(query)
    if title is None:
        raise ValueError(
            f"No Wikipedia articles found for '{query}'. "
            "Ensure the index has been built with: python scripts/ingest_wikipedia.py"
        )

    col = _get_collection()

    # Count how many chunks belong to this article (used to cap n_results safely)
    article_data = col.get(
        where={"title": {"$eq": title}},
        include=["documents"],
    )
    chunk_count = len(article_data["ids"])

    _current_session = WikipediaSession(
        article_title=title,
        chunk_count=chunk_count,
    )
    logger.info(f"Wikipedia session started: '{title}' ({chunk_count} chunks)")
    return _current_session


# ── Retrieval ──────────────────────────────────────────────────────────────────

def retrieve_chunks(query: str, top_k: int = TOP_K_DEFAULT) -> list[str]:
    """
    Return the top_k most relevant text chunks from the active article session.
    Scoped to the current article via a ChromaDB metadata filter.
    Returns [] when no session is active or the article has no indexed chunks.
    """
    session = _current_session
    if session is None:
        return []

    n = min(top_k, session.chunk_count)
    if n == 0:
        return []

    col       = _get_collection()
    embedding = _embed_query(query)

    results = col.query(
        query_embeddings=[embedding],
        n_results=n,
        where={"title": {"$eq": session.article_title}},
        include=["documents"],
    )

    return results["documents"][0] if results["documents"] else []


# ── System prompt ──────────────────────────────────────────────────────────────

_WIKI_SYSTEM_PROMPT_TEMPLATE = """\
You are S.T.A.R.L.I.N.G., operating in Wikipedia Article Mode.

ARTICLE IN CONTEXT: "{title}"

You have been given excerpts from the Wikipedia article above. Your behaviour \
in this mode is strictly governed by the following rules:

RULES:
1. You MUST only answer questions using information present in the provided \
article excerpts below.
2. If the answer to a question is not found in the excerpts, say clearly: \
"That detail is not covered in this article." Do not guess, infer, or \
supplement with outside knowledge.
3. Do not present any information as fact unless it appears directly in the excerpts.
4. Do not reference other Wikipedia articles, external sources, or your own \
training data.
5. Keep answers concise and suitable for spoken audio — two to four sentences \
unless more is needed for accuracy.
6. After each answer, invite the user to ask another question about the article \
with a brief prompt such as "What else would you like to know?"
7. Respond in plain prose only — never use markdown, asterisks, bullet points, \
numbered lists, backticks, or headers.
8. Never prefix your response with your name or any speaker label — begin \
speaking immediately.

ARTICLE EXCERPTS:
{excerpts}

This is the first turn of the session. Greet the user briefly, confirm which \
article has been loaded, and ask what they would like to learn from it.\
"""


def build_wiki_system_prompt(excerpts: list[str]) -> str:
    """Build the article-scoped guardrailed system prompt for the LLM."""
    session = _current_session
    if session is None:
        return ""

    excerpts_text = (
        "\n\n---\n\n".join(excerpts)
        if excerpts
        else "(No excerpts could be retrieved for this article.)"
    )
    return _WIKI_SYSTEM_PROMPT_TEMPLATE.format(
        title=session.article_title,
        excerpts=excerpts_text,
    )


# ── Status ─────────────────────────────────────────────────────────────────────

def get_wiki_status() -> dict:
    """Return index and session status — used by GET /wiki/status."""
    try:
        col   = _get_collection()
        count = col.count()
        return {
            "indexed":     count > 0,
            "chunk_count": count,
            "collection":  WIKI_COLLECTION,
            "embed_model": EMBEDDING_MODEL,
            "session":     _current_session.to_status() if _current_session else None,
        }
    except Exception as exc:
        return {"indexed": False, "error": str(exc)}
