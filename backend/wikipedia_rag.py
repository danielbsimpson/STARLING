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
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
import prompts
import soul

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

    Also warms up the embedding model with a dummy encode so the first real
    /wiki/start request isn't penalised by the ~40s model-load cost.
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

    # Warm up the embedding model now (in the startup thread) so the first
    # user query embeds instantly instead of triggering a cold model load.
    try:
        _embed_query("warm up")
        logger.info("Wikipedia: embedding model warmed up.")
    except Exception as exc:
        logger.warning(f"Wikipedia: embedding warm-up failed (non-fatal) — {exc}")


# ── Article discovery ──────────────────────────────────────────────────────────

def _normalize_title(text: str) -> str:
    """Lowercase, strip punctuation/whitespace, and singularize a simple trailing
    plural so 'large language models' and 'Large language model' compare equal."""
    import re
    t = re.sub(r"[^\w\s]", "", text.lower()).strip()
    t = re.sub(r"\s+", " ", t)
    # Crude singularization: 'models' -> 'model', 'batteries' -> 'battery'.
    if t.endswith("ies") and len(t) > 4:
        t = t[:-3] + "y"
    elif t.endswith("ses") and len(t) > 4:
        t = t[:-2]
    elif t.endswith("s") and not t.endswith("ss") and len(t) > 3:
        t = t[:-1]
    return t


def _title_candidates(query: str) -> list[str]:
    """Common casing + plural/singular variants of a query for exact-title
    matching.

    Simple-English Wikipedia titles are usually sentence-case and singular
    (e.g. 'Machine learning', 'Large language model'), so capitalize() of the
    singular form is the most likely hit.
    """
    q = query.strip()
    forms = [q]
    # Add a singular form by trimming a simple trailing plural.
    if q.lower().endswith("ies") and len(q) > 4:
        forms.append(q[:-3] + "y")
    elif q.lower().endswith("ses") and len(q) > 4:
        forms.append(q[:-2])
    elif q.lower().endswith("s") and not q.lower().endswith("ss") and len(q) > 3:
        forms.append(q[:-1])

    out: list[str] = []
    for form in forms:
        for cand in (form, form.capitalize(), form.title(), form.lower(), form.upper()):
            if cand and cand not in out:
                out.append(cand)
    return out


def find_article(query: str) -> Optional[str]:
    """
    Find the best-matching Wikipedia article title for a user query.

    Strategy:
      1. Exact-title fast path — if the query (in any common casing or simple
         singular/plural form) matches an article title verbatim, use it. This
         stops a tangentially-related article from out-voting the article the
         user actually named.
      2. Semantic fallback — embed the query, pull the top-20 nearest chunks,
         and pick the title with the highest *similarity-weighted* score
         (sum of 1 - cosine_distance). Titles whose normalized form matches the
         query get a large bonus so a directly-named article beats one that
         merely mentions the topic a lot.

    Returns None when the index is empty or no match is found.
    """
    col = _get_collection()
    total = col.count()
    if total == 0:
        return None

    # 1) Exact-title fast path.
    for cand in _title_candidates(query):
        hit = col.get(where={"title": {"$eq": cand}}, limit=1)
        if hit["ids"]:
            return cand

    # 2) Similarity-weighted semantic vote with a title-match bonus.
    embedding = _embed_query(query)
    n_results = min(20, total)

    results = col.query(
        query_embeddings=[embedding],
        n_results=n_results,
        include=["metadatas", "distances"],
    )

    metas = results["metadatas"][0] if results["metadatas"] else []
    dists = results["distances"][0] if results.get("distances") else []
    if not metas:
        return None

    query_norm = _normalize_title(query)
    scores: dict[str, float] = {}
    for meta, dist in zip(metas, dists):
        title = meta.get("title")
        if not title:
            continue
        # Cosine distance → similarity weight; closer chunks count for more.
        weight = 1.0 - dist
        title_norm = _normalize_title(title)
        # Strong bonus when the title matches the query (exactly or as a
        # substring), so 'Large language model' beats 'Mistral AI' for the
        # query 'large language models'.
        if title_norm == query_norm:
            weight += 5.0
        elif query_norm and (query_norm in title_norm or title_norm in query_norm):
            weight += 2.0
        scores[title] = scores.get(title, 0.0) + weight

    if not scores:
        return None

    return max(scores, key=scores.get)


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
# The wiki system prompt is now stored in the prompts registry as WIKI_ARTICLE_MODE.
# See backend/prompts.py for the default template and pipeline documentation.


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
    return soul.inject(prompts.get("WIKI_ARTICLE_MODE", title=session.article_title, excerpts=excerpts_text))


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
