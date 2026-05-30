"""backend/mail_routes.py
Apple Mail inbox reader via IMAP (stdlib only — no new pip packages).

Fetches all messages from the past 7 days (read + unread) from INBOX.
Results are persisted to a disk-based JSON cache with a 5-minute TTL —
identical in approach to weather.py and stocks.py — so IMAP is only
contacted at most once every MAIL_CACHE_SECONDS seconds.

Endpoints:
  GET    /mail/unread        — fetch inbox messages + llm_context string
  DELETE /mail/cache         — clear disk cache
  GET    /mail/credentials   — return credential status (password masked)
  POST   /mail/credentials   — save dedicated IMAP credentials (localhost only)
  DELETE /mail/credentials   — remove dedicated credentials (localhost only)

Credential priority:  mail_credentials.json > calendar_credentials.json > env vars
"""

import asyncio
import email
import email.header
import imaplib
import json
import os
import ssl
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import session_log

router = APIRouter()

# ── Config ────────────────────────────────────────────────────────────────────
_BASE_DIR        = Path(__file__).parent
_MAIL_CRED_FILE  = _BASE_DIR / "memory" / "mail_credentials.json"
_CAL_CRED_FILE   = _BASE_DIR / "memory" / "calendar_credentials.json"
_CACHE_FILE      = _BASE_DIR / "memory" / "mail_cache.json"

_MAX_MESSAGES    = int(os.getenv("MAIL_MAX_MESSAGES", "50"))   # total cap across all messages
_CACHE_SECS      = int(os.getenv("MAIL_CACHE_SECONDS", "300")) # 5 minutes
_LOOKBACK_DAYS   = int(os.getenv("MAIL_LOOKBACK_DAYS", "7"))   # how far back to search

# ── Startup: ensure cache file exists ────────────────────────────────────────
_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
if not _CACHE_FILE.exists():
    _CACHE_FILE.write_text("{}", encoding="utf-8")


def _is_localhost(request: Request) -> bool:
    return request.client is not None and request.client.host in session_log.LOCALHOST_HOSTS

# ── Disk-cache helpers ────────────────────────────────────────────────────────

def _load_cache() -> dict:
    """Load the on-disk JSON cache. Returns {} on read/parse error."""
    from file_utils import load_json_cache
    return load_json_cache(_CACHE_FILE)


def _save_cache(data: dict) -> None:
    """Write cache atomically: write to .tmp then os.replace."""
    payload = {"ts": time.time(), "data": data}
    tmp = _CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _CACHE_FILE)


def _invalidate_cache() -> None:
    """Wipe the disk cache so the next request hits IMAP."""
    try:
        _CACHE_FILE.write_text("{}", encoding="utf-8")
    except OSError:
        pass


def _cache_hit() -> dict | None:
    """Return cached data if it is still within TTL, otherwise None."""
    raw = _load_cache()
    if not raw or "ts" not in raw or "data" not in raw:
        return None
    if (time.time() - raw["ts"]) >= _CACHE_SECS:
        return None
    return raw["data"]


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
        try:
            stored   = json.loads(_MAIL_CRED_FILE.read_text(encoding="utf-8"))
            username = stored.get("username", username)
            password = stored.get("password", password)
        except Exception:
            pass  # best-effort: corrupt creds file → fall back to env vars
    elif _CAL_CRED_FILE.exists():
        try:
            stored = json.loads(_CAL_CRED_FILE.read_text(encoding="utf-8"))
            if not username:
                username = stored.get("username", "")
            if not password:
                password = stored.get("password", "")
        except Exception:
            pass  # best-effort: corrupt CalDAV creds → fall back to env vars

    return {"host": host, "port": port, "username": username, "password": password}


# ── IMAP fetch (blocking — run inside executor) ───────────────────────────────

def _fetch_inbox_sync(
    host: str, port: int, username: str, password: str,
    max_messages: int, lookback_days: int,
) -> list[dict]:
    """Open an IMAP4_SSL connection and fetch all messages from the past
    `lookback_days` days (both read and unread).

    Each returned dict contains:
        from_address, subject, date, read (bool)

    Only FROM, SUBJECT, DATE, FLAGS are retrieved — no body content.
    Connection is always closed in the finally block.
    """
    since_date = (datetime.now(timezone.utc) - timedelta(days=lookback_days))
    # IMAP SINCE format: DD-Mon-YYYY  e.g. "21-May-2026"
    since_str  = since_date.strftime("%d-%b-%Y")

    ctx  = ssl.create_default_context()
    mail = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
    try:
        mail.login(username, password)
        mail.select("INBOX", readonly=True)

        # Fetch all messages since the lookback date (read + unread)
        status, data = mail.search(None, f"(SINCE {since_str})")
        if status != "OK" or not data or not data[0]:
            return []

        uid_list = data[0].split()
        # Most recent first; cap total
        uid_list = list(reversed(uid_list))[:max_messages]

        messages: list[dict] = []
        for uid in uid_list:
            fetch_status, msg_data = mail.fetch(
                uid, "(FLAGS BODY[HEADER.FIELDS (FROM SUBJECT DATE)])"
            )
            if fetch_status != "OK" or not msg_data:
                continue

            # FLAGS are in the first part of a multi-part response
            flags_str = ""
            raw_headers = b""
            for part in msg_data:
                if isinstance(part, tuple):
                    # part[0] contains the metadata line including flags
                    meta = part[0].decode(errors="replace") if isinstance(part[0], bytes) else str(part[0])
                    flags_str += meta
                    raw_headers = part[1] if isinstance(part[1], bytes) else b""

            if not raw_headers:
                continue

            read = "\\Seen" in flags_str

            msg = email.message_from_bytes(raw_headers)

            from_addr   = msg.get("From", "")
            raw_subject = msg.get("Subject", "")
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
                    "read":         read,
                }
            )

        return messages
    finally:
        try:
            mail.logout()
        except Exception:
            pass  # best-effort: IMAP logout is idempotent; ignore close errors


def _build_llm_context(messages: list[dict]) -> str:
    total  = len(messages)
    if total == 0:
        return "[MAIL DATA — No messages in the past 7 days.]"

    unread = [m for m in messages if not m["read"]]
    read   = [m for m in messages if     m["read"]]

    lines = [
        f"[MAIL DATA — {total} message(s) in the past 7 days: "
        f"{len(unread)} unread, {len(read)} read]"
    ]

    if unread:
        lines.append("UNREAD:")
        for m in unread:
            lines.append(f"  - From: {m['from_address']} | Subject: {m['subject']}")

    if read:
        lines.append("READ:")
        for m in read:
            lines.append(f"  - From: {m['from_address']} | Subject: {m['subject']}")

    return "\n".join(lines)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/mail/unread")
async def get_mail_inbox():
    """Fetch inbox messages (read + unread) from the past 7 days via IMAP.

    Returns: { unread_count, total_count, messages, llm_context }
    Results are persisted to disk and served from cache for up to
    MAIL_CACHE_SECONDS (default 5 min) to avoid hammering IMAP.
    """
    _t0 = time.monotonic()
    creds = _load_credentials()
    if not creds["username"] or not creds["password"]:
        raise HTTPException(
            status_code=503,
            detail="Mail credentials not configured.",
        )

    # Serve from disk cache if still fresh
    cached = _cache_hit()
    if cached is not None:
        return cached

    try:
        loop     = asyncio.get_running_loop()
        messages = await loop.run_in_executor(
            None,
            _fetch_inbox_sync,
            creds["host"],
            creds["port"],
            creds["username"],
            creds["password"],
            _MAX_MESSAGES,
            _LOOKBACK_DAYS,
        )
    except imaplib.IMAP4.error as exc:
        raise HTTPException(status_code=502, detail=f"IMAP error: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Mail fetch failed: {exc}") from exc

    unread_count = sum(1 for m in messages if not m["read"])
    llm_context  = _build_llm_context(messages)

    data = {
        "unread_count": unread_count,
        "total_count":  len(messages),
        "messages":     messages,
        "llm_context":  llm_context,
    }
    _save_cache(data)
    try:
        import system_state
        system_state.record_event(
            "mail_fetch",
            duration_s=round(time.monotonic() - _t0, 3),
            metadata={"unread": unread_count, "total": len(messages), "cache_hit": False},
        )
    except Exception:
        pass
    return data


@router.delete("/mail/cache")
async def bust_mail_cache():
    """Clear the disk cache so the next fetch hits IMAP directly."""
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
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Forbidden")

    username = body.username.strip()
    if not username or not body.password:
        raise HTTPException(
            status_code=422, detail="username and password are required"
        )

    creds = {"username": username, "password": body.password}
    tmp = _MAIL_CRED_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(creds, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, _MAIL_CRED_FILE)
    _invalidate_cache()
    try:
        import system_state
        system_state.refresh_tool_inventory()
    except Exception:
        pass
    return {"status": "saved"}


@router.delete("/mail/credentials")
async def delete_mail_credentials(request: Request):
    """Remove dedicated mail credentials. Restricted to localhost connections."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Forbidden")

    if _MAIL_CRED_FILE.exists():
        _MAIL_CRED_FILE.unlink()
    _invalidate_cache()
    try:
        import system_state
        system_state.refresh_tool_inventory()
    except Exception:
        pass
    return {"status": "removed"}

