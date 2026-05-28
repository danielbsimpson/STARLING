"""backend/mail_routes.py
Apple Mail inbox reader via IMAP (stdlib only — no new pip packages).

Endpoints:
  GET    /mail/unread        — fetch unread messages + llm_context string
  DELETE /mail/cache         — clear in-memory cache
  GET    /mail/credentials   — return credential status (password masked)
  POST   /mail/credentials   — save dedicated IMAP credentials (localhost only)
  DELETE /mail/credentials   — remove dedicated credentials (localhost only)

Credential priority:  mail_credentials.json > calendar_credentials.json > env vars
"""

import email
import email.header
import imaplib
import json
import os
import ssl
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import session_log

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_BASE_DIR       = Path(__file__).parent
_MAIL_CRED_FILE = _BASE_DIR / "memory" / "mail_credentials.json"
_CAL_CRED_FILE  = _BASE_DIR / "memory" / "calendar_credentials.json"

_MAX_UNREAD = int(os.getenv("MAIL_MAX_UNREAD",    "20"))
_CACHE_SECS = int(os.getenv("MAIL_CACHE_SECONDS", "300"))

# ── In-memory cache ───────────────────────────────────────────────────────────
_cache: dict = {"ts": 0.0, "data": None}


def _invalidate_cache() -> None:
    _cache["ts"]   = 0.0
    _cache["data"] = None


# ── Credential helpers ────────────────────────────────────────────────────────

def _load_credentials() -> dict:
    """Return IMAP connection parameters using priority order:
    mail_credentials.json > (calendar_credentials.json if no env vars) > env vars.
    """
    host     = os.getenv("IMAP_HOST",     "imap.mail.me.com")
    port     = int(os.getenv("IMAP_PORT", "993"))
    username = os.getenv("IMAP_USERNAME", "")
    password = os.getenv("IMAP_PASSWORD", "")

    if _MAIL_CRED_FILE.exists():
        # Dedicated mail credentials take priority over everything
        try:
            stored   = json.loads(_MAIL_CRED_FILE.read_text(encoding="utf-8"))
            username = stored.get("username", username)
            password = stored.get("password", password)
        except Exception:
            pass
    elif _CAL_CRED_FILE.exists():
        # Fall back to calendar credentials only when no env var overrides are set
        try:
            stored = json.loads(_CAL_CRED_FILE.read_text(encoding="utf-8"))
            if not username:
                username = stored.get("username", "")
            if not password:
                password = stored.get("password", "")
        except Exception:
            pass

    return {"host": host, "port": port, "username": username, "password": password}


# ── IMAP fetch (blocking — run inside executor) ───────────────────────────────

def _fetch_unread_sync(
    host: str, port: int, username: str, password: str, max_count: int
) -> list[dict]:
    """Open an IMAP4_SSL connection, fetch unseen message headers, and return them.

    Always closed in the finally block. Only FROM, SUBJECT, DATE headers are
    retrieved — no body content is ever fetched (CON-003).
    """
    ctx  = ssl.create_default_context()
    mail = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
    try:
        mail.login(username, password)
        mail.select("INBOX", readonly=True)

        status, data = mail.search(None, "(UNSEEN)")
        if status != "OK" or not data or not data[0]:
            return []

        uid_list = data[0].split()
        # Most recent first; cap at max_count
        uid_list = list(reversed(uid_list))[:max_count]

        messages: list[dict] = []
        for uid in uid_list:
            fetch_status, msg_data = mail.fetch(
                uid, "(BODY[HEADER.FIELDS (FROM SUBJECT DATE)])"
            )
            if fetch_status != "OK" or not msg_data or not msg_data[0]:
                continue

            raw = msg_data[0][1] if isinstance(msg_data[0], tuple) else b""
            if not raw:
                continue

            msg = email.message_from_bytes(raw)

            from_addr    = msg.get("From", "")
            raw_subject  = msg.get("Subject", "")
            try:
                subject = str(
                    email.header.make_header(
                        email.header.decode_header(raw_subject)
                    )
                )
            except Exception:
                subject = raw_subject

            messages.append(
                {
                    "from_address": from_addr,
                    "subject":      subject,
                    "date":         msg.get("Date", ""),
                }
            )

        return messages
    finally:
        try:
            mail.logout()
        except Exception:
            pass


def _build_llm_context(messages: list[dict], unread_count: int) -> str:
    if unread_count == 0:
        return "[MAIL DATA — Inbox is empty. No unread messages.]"
    lines = [f"[MAIL DATA — {unread_count} unread message(s)]"]
    for m in messages:
        lines.append(f"- From: {m['from_address']} | Subject: {m['subject']}")
    return "\n".join(lines)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/mail/unread")
async def get_mail_unread():
    """Fetch unread emails from IMAP.

    Returns: { unread_count, messages, llm_context }
    Served from in-memory cache for up to MAIL_CACHE_SECONDS (default 5 min).
    """
    import asyncio

    creds = _load_credentials()
    if not creds["username"] or not creds["password"]:
        raise HTTPException(
            status_code=503,
            detail="Mail credentials not configured.",
        )

    # Return cache hit if still valid
    if _cache["data"] is not None and (time.time() - _cache["ts"]) < _CACHE_SECS:
        return _cache["data"]

    try:
        loop     = asyncio.get_event_loop()
        messages = await loop.run_in_executor(
            None,
            _fetch_unread_sync,
            creds["host"],
            creds["port"],
            creds["username"],
            creds["password"],
            _MAX_UNREAD,
        )
    except imaplib.IMAP4.error as exc:
        raise HTTPException(status_code=502, detail=f"IMAP error: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Mail fetch failed: {exc}") from exc

    unread_count = len(messages)
    llm_context  = _build_llm_context(messages, unread_count)

    data = {
        "unread_count": unread_count,
        "messages":     messages,
        "llm_context":  llm_context,
    }
    _cache["ts"]   = time.time()
    _cache["data"] = data
    return data


@router.delete("/mail/cache")
async def bust_mail_cache():
    """Clear the in-memory mail cache so the next fetch hits IMAP directly."""
    _invalidate_cache()
    return {"status": "cleared"}


@router.get("/mail/credentials")
async def get_mail_credentials():
    """Return mail credential status — password is never included in the response."""
    creds    = _load_credentials()
    username = creds.get("username", "")
    return {"configured": bool(username), "username": username}


class _MailCredentials(BaseModel):
    username: str
    password: str


@router.post("/mail/credentials")
async def save_mail_credentials(body: _MailCredentials, request: Request):
    """Save dedicated IMAP credentials. Restricted to localhost connections."""
    client_host = request.client.host if request.client else ""
    if client_host not in session_log.LOCALHOST_HOSTS:
        raise HTTPException(status_code=403, detail="Forbidden")

    username = body.username.strip()
    if not username or not body.password:
        raise HTTPException(
            status_code=422, detail="username and password are required"
        )

    creds = {"username": username, "password": body.password}
    _MAIL_CRED_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _MAIL_CRED_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(creds, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _MAIL_CRED_FILE)
    _invalidate_cache()
    return {"status": "saved"}


@router.delete("/mail/credentials")
async def delete_mail_credentials(request: Request):
    """Remove dedicated mail credentials. Restricted to localhost connections."""
    client_host = request.client.host if request.client else ""
    if client_host not in session_log.LOCALHOST_HOSTS:
        raise HTTPException(status_code=403, detail="Forbidden")

    if _MAIL_CRED_FILE.exists():
        _MAIL_CRED_FILE.unlink()
    _invalidate_cache()
    return {"status": "removed"}
