"""
scripts/ingest_wikipedia.py
One-time ingestion script: parses the Simple English Wikipedia XML dump,
chunks articles section by section, embeds each chunk with nomic-embed-text,
and stores the results in the existing ChromaDB under a dedicated
'wikipedia_articles' collection.

Run from the repository root:
    python scripts/ingest_wikipedia.py

Download the dump first (see markdown/WIKIPEDIA.md — Step 1):
    Invoke-WebRequest `
      -Uri "https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-pages-articles.xml.bz2" `
      -OutFile "assets\\wikipedia\\simplewiki-latest-pages-articles.xml.bz2"
"""

import bz2
import hashlib
import logging
import os
import re
import sys
from pathlib import Path

# Must be set before PyTorch is imported (sentence_transformers pulls it in).
# Allows the CUDA allocator to use non-contiguous memory segments, which
# prevents fragmentation-based OOM on long-running ingestion jobs.
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import torch
import chromadb
import mwparserfromhell
import mwxml
from sentence_transformers import SentenceTransformer
from tqdm import tqdm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
logger = logging.getLogger(__name__)

# ── Configuration ─────────────────────────────────────────────────────────────
DUMP_PATH       = Path("assets/wikipedia/simplewiki-latest-pages-articles.xml.bz2")
CHROMA_PATH     = "backend/memory/chroma_db"
WIKI_COLLECTION = "wikipedia_articles"

EMBEDDING_MODEL  = "nomic-ai/nomic-embed-text-v1"
EMBEDDING_DEVICE = "cuda"   # set to "cpu" if GPU is reserved for the LLM

BATCH_SIZE       = 32       # sentence-transformers encode batch size (lower = less peak VRAM)
INGEST_CHUNK     = 640      # number of text chunks to upsert per ChromaDB batch
MAX_CHUNK_CHARS  = 800
OVERLAP_CHARS    = 80

# nomic-embed-text uses task prefixes for asymmetric retrieval
DOCUMENT_PREFIX  = "search_document: "

SKIP_SECTIONS = {
    "references", "external links", "see also",
    "further reading", "notes", "footnotes", "bibliography",
    "other websites",   # Simple English Wikipedia variant
}


# ── Text helpers ──────────────────────────────────────────────────────────────

def _split_text(text: str) -> list[str]:
    """Sentence-aware chunking with character-level overlap."""
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        if len(current) + len(sentence) + 1 <= MAX_CHUNK_CHARS:
            current = (current + " " + sentence).strip()
        else:
            if current:
                chunks.append(current)
            overlap = current[-OVERLAP_CHARS:] if len(current) > OVERLAP_CHARS else current
            current = (overlap + " " + sentence).strip()
    if current:
        chunks.append(current)
    return chunks


def extract_chunks(title: str, wikitext: str) -> list[dict]:
    """
    Parse wikitext into section-aware text chunks.
    Returns list of {title, section, text}.
    """
    try:
        parsed = mwparserfromhell.parse(wikitext)
    except Exception:
        return []

    results: list[dict] = []
    current_section = ""
    current_text: list[str] = []

    def _flush():
        text = " ".join(current_text).strip()
        if text and current_section.lower() not in SKIP_SECTIONS:
            for chunk in _split_text(text):
                prefix = f"[{current_section}] " if current_section else ""
                results.append({
                    "title":   title,
                    "section": current_section,
                    "text":    prefix + chunk,
                })

    for node in parsed.nodes:
        if isinstance(node, mwparserfromhell.nodes.Heading):
            _flush()
            current_section = node.title.strip_code().strip()
            current_text = []
        elif isinstance(node, mwparserfromhell.nodes.Text):
            line = str(node).strip()
            if line:
                current_text.append(line)

    _flush()
    return results


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    if not DUMP_PATH.exists():
        logger.error(f"Dump not found at: {DUMP_PATH}")
        logger.error("Download the Simple English Wikipedia dump first.")
        logger.error("See markdown/WIKIPEDIA.md — Step 1 for instructions.")
        sys.exit(1)

    logger.info(f"Loading embedding model: {EMBEDDING_MODEL} on {EMBEDDING_DEVICE}")
    model = SentenceTransformer(
        EMBEDDING_MODEL,
        device=EMBEDDING_DEVICE,
        trust_remote_code=True,
    )

    logger.info(f"Opening ChromaDB at: {CHROMA_PATH}")
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    col = client.get_or_create_collection(
        WIKI_COLLECTION,
        metadata={"hnsw:space": "cosine"},
    )
    existing = col.count()
    resume = False
    if existing > 0:
        logger.info(f"Collection '{WIKI_COLLECTION}' already has {existing:,} chunks.")
        ans = input(
            "[r] Resume from existing chunks  "
            "[f] Full re-ingest from scratch  "
            "[a] Abort  (r/f/a): "
        ).strip().lower()
        if ans == "a" or ans == "":
            logger.info("Aborted.")
            sys.exit(0)
        elif ans == "r":
            resume = True
            logger.info(f"Will resume — skipping first {existing:,} chunks already in collection.")
        # 'f' falls through and re-ingests everything

    logger.info(f"Parsing dump: {DUMP_PATH}")
    dump = mwxml.Dump.from_file(bz2.open(str(DUMP_PATH), "rb"))

    all_chunks: list[dict] = []
    for page in tqdm(dump.pages, desc="Parsing articles", unit="art"):
        if page.namespace != 0:
            continue
        revision = next(iter(page), None)
        if revision is None or page.redirect:
            continue
        chunks = extract_chunks(page.title, revision.text or "")
        all_chunks.extend(chunks)

    logger.info(f"Extracted {len(all_chunks):,} text chunks from dump")

    # Deduplicate by content — some articles share identical short sections.
    # Pre-attach the ID so the upsert loop doesn't recompute it per chunk.
    seen_ids: set[str] = set()
    deduped: list[dict] = []
    for c in all_chunks:
        cid = hashlib.md5(
            f"{c['title']}:{c['section']}:{c['text']}".encode()
        ).hexdigest()
        if cid not in seen_ids:
            seen_ids.add(cid)
            c["_id"] = cid
            deduped.append(c)
    removed = len(all_chunks) - len(deduped)
    if removed:
        logger.info(f"Removed {removed:,} duplicate chunks — {len(deduped):,} unique remain")
    all_chunks = deduped

    # Skip already-ingested chunks when resuming after a crash.
    if resume and existing > 0:
        skip = min(existing, len(all_chunks))
        all_chunks = all_chunks[skip:]
        logger.info(f"Resuming from chunk {skip:,} — {len(all_chunks):,} chunks remaining")

    # Embed and upsert in rolling batches to keep memory usage bounded
    total_ingested = 0
    for batch_idx, start in enumerate(tqdm(range(0, len(all_chunks), INGEST_CHUNK), desc="Ingesting batches")):
        batch_meta = all_chunks[start : start + INGEST_CHUNK]
        batch_text = [DOCUMENT_PREFIX + c["text"] for c in batch_meta]

        embeddings = model.encode(
            batch_text,
            batch_size=BATCH_SIZE,
            normalize_embeddings=True,
            show_progress_bar=False,
        )

        ids: list[str]    = []
        docs: list[str]   = []
        metas: list[dict] = []
        embeds: list      = []

        for chunk, emb in zip(batch_meta, embeddings):
            ids.append(chunk["_id"])
            docs.append(chunk["text"])          # raw text (no prefix) stored in DB
            metas.append({
                "title":   chunk["title"],
                "section": chunk["section"],
            })
            embeds.append(emb.tolist())

        col.upsert(ids=ids, embeddings=embeds, documents=docs, metadatas=metas)
        total_ingested += len(ids)

        # Release fragmented reserved VRAM back to the pool every 50 batches.
        if EMBEDDING_DEVICE == "cuda" and batch_idx % 50 == 49:
            torch.cuda.empty_cache()

    logger.info(f"Ingestion complete — {total_ingested:,} chunks upserted.")
    logger.info(f"Collection '{WIKI_COLLECTION}' total: {col.count():,} chunks.")


if __name__ == "__main__":
    main()
