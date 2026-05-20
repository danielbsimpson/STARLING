"""backend/log_routes.py — Read-only session log API endpoints.

Endpoints:
  GET  /log/sessions                  — list all session log files
  GET  /log/sessions/{session_id}     — return raw JSONL for a session
  POST /log/event                     — accept a frontend-originated event
  GET  /log/viewer                    — human-readable HTML log viewer
"""

import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel, field_validator

import session_log

router = APIRouter(prefix="/log", tags=["log"])

# Session ID must match this pattern to prevent path traversal attacks.
_SESSION_ID_RE = re.compile(r"^session_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")

_ALLOWED_FRONTEND_EVENTS = {"tool_dispatch", "user_text", "user_speech_frontend", "error"}

_LOCALHOST_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _is_localhost(request: Request) -> bool:
    return request.client is not None and request.client.host in _LOCALHOST_HOSTS


# ── Models ─────────────────────────────────────────────────────────────────────

class FrontendEvent(BaseModel):
    event_type: str
    data: dict
    source: str = "frontend"

    @field_validator("event_type")
    @classmethod
    def validate_event_type(cls, v: str) -> str:
        if v not in _ALLOWED_FRONTEND_EVENTS:
            raise ValueError(
                f"event_type '{v}' is not allowed. Must be one of: {sorted(_ALLOWED_FRONTEND_EVENTS)}"
            )
        return v


# ── Helpers ───────────────────────────────────────────────────────────────────

def _count_lines(path: Path) -> int:
    try:
        count = 0
        with open(path, "r", encoding="utf-8") as fh:
            for _ in fh:
                count += 1
        return count
    except OSError:
        return 0


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/sessions")
def list_sessions(request: Request):
    """List all session log files. Localhost only."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    files = sorted(session_log.LOG_DIR.glob("*.jsonl"), reverse=True)
    result = []
    for f in files:
        stat = f.stat()
        # Parse start_time from filename: session_YYYY-MM-DD_HH-MM-SS.jsonl
        ts_str = f.stem.replace("session_", "").replace("_", "T", 1).replace("-", ":", 2)
        result.append({
            "session_id":  f.stem,
            "start_time":  ts_str,
            "size_bytes":  stat.st_size,
            "event_count": _count_lines(f),
        })
    return result


@router.get("/sessions/{session_id}", response_class=PlainTextResponse)
def get_session(session_id: str, request: Request):
    """Return raw JSONL content of a session log. Localhost only."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id format.")

    path = session_log.LOG_DIR / f"{session_id}.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")

    return path.read_text(encoding="utf-8")


@router.post("/event")
def ingest_frontend_event(event: FrontendEvent):
    """Accept a frontend-originated log event and write it to the current session."""
    session_log.log(event.event_type, event.data, source=event.source)
    return {"ok": True, "session": session_log.get_session_id()}


@router.get("/viewer", response_class=HTMLResponse)
def log_viewer():
    """Serve a minimal HTML log viewer page."""
    html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>S.T.A.R.L.I.N.G. Session Log Viewer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d0d0d; color: #c8c8c8; font-family: 'Consolas', 'Courier New', monospace; font-size: 13px; padding: 16px; }
  h1 { font-size: 15px; color: #5599ff; letter-spacing: 2px; margin-bottom: 14px; text-transform: uppercase; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
  select { background: #1a1a2e; color: #c8c8c8; border: 1px solid #334; padding: 6px 10px; font-family: inherit; font-size: 12px; border-radius: 4px; min-width: 340px; }
  button { background: #1a2a4a; color: #88aaff; border: 1px solid #334; padding: 6px 14px; font-family: inherit; font-size: 12px; border-radius: 4px; cursor: pointer; }
  button:hover { background: #223355; }
  #status { color: #556677; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #111827; color: #5599ff; text-align: left; padding: 6px 10px; border-bottom: 1px solid #223; position: sticky; top: 0; }
  td { padding: 5px 10px; border-bottom: 1px solid #1a1a1a; vertical-align: top; word-break: break-word; }
  tr:hover td { background: #111; }
  td.ts { color: #445566; white-space: nowrap; font-size: 11px; }
  td.src { color: #667788; }
  td.data { font-size: 11px; color: #aabbcc; max-width: 500px; }
  .ev-session_start   { color: #66ffaa; }
  .ev-session_end     { color: #66ffaa; }
  .ev-user_speech     { color: #88ccff; }
  .ev-user_speech_frontend { color: #66aaee; }
  .ev-user_text       { color: #aaddff; }
  .ev-tool_dispatch   { color: #ffdd88; }
  .ev-tool_call       { color: #ffaa44; }
  .ev-tool_result     { color: #44cc88; }
  .ev-llm_request     { color: #cc88ff; }
  .ev-llm_response    { color: #aa66ee; }
  .ev-error           { color: #ff6677; }
  #table-wrap { max-height: calc(100vh - 120px); overflow-y: auto; }
  .empty { color: #445566; padding: 30px; text-align: center; }
</style>
</head>
<body>
<h1>S.T.A.R.L.I.N.G. &mdash; Session Log Viewer</h1>
<div class="controls">
  <select id="sess-select"><option value="">Loading sessions…</option></select>
  <button onclick="loadSession()">Load</button>
  <span id="status"></span>
</div>
<div id="table-wrap">
  <div class="empty" id="empty-msg">Select a session above to view its events.</div>
  <table id="log-table" style="display:none">
    <thead><tr><th>#</th><th>Timestamp</th><th>Source</th><th>Event</th><th>Data</th></tr></thead>
    <tbody id="log-body"></tbody>
  </table>
</div>
<script>
async function loadSessions() {
  try {
    const r = await fetch('/log/sessions');
    if (!r.ok) { document.getElementById('status').textContent = 'Error loading sessions'; return; }
    const sessions = await r.json();
    const sel = document.getElementById('sess-select');
    sel.innerHTML = sessions.length
      ? sessions.map(s => `<option value="${s.session_id}">${s.session_id} &nbsp; (${s.event_count} events, ${(s.size_bytes/1024).toFixed(1)} KB)</option>`).join('')
      : '<option value="">No sessions found</option>';
    if (sessions.length) loadSession();
  } catch(e) { document.getElementById('status').textContent = 'Failed to fetch sessions: ' + e.message; }
}

async function loadSession() {
  const sid = document.getElementById('sess-select').value;
  if (!sid) return;
  const statusEl = document.getElementById('status');
  statusEl.textContent = 'Loading…';
  try {
    const r = await fetch('/log/sessions/' + sid);
    if (!r.ok) { statusEl.textContent = 'Error ' + r.status; return; }
    const text = await r.text();
    const lines = text.trim().split('\\n').filter(Boolean);
    const tbody = document.getElementById('log-body');
    tbody.innerHTML = '';
    lines.forEach((line, i) => {
      try {
        const ev = JSON.parse(line);
        const cls = 'ev-' + (ev.event || '');
        const dataStr = JSON.stringify(ev.data, null, 0);
        const shortData = dataStr.length > 300 ? dataStr.slice(0, 300) + '…' : dataStr;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${i + 1}</td>
          <td class="ts">${(ev.ts || '').replace('T', ' ').slice(0, 23)}</td>
          <td class="src">${ev.source || ''}</td>
          <td class="${cls}">${ev.event || ''}</td>
          <td class="data" title="${dataStr.replace(/"/g,'&quot;')}">${shortData}</td>`;
        tbody.appendChild(tr);
      } catch { /* skip malformed line */ }
    });
    document.getElementById('log-table').style.display = lines.length ? 'table' : 'none';
    document.getElementById('empty-msg').style.display = lines.length ? 'none' : 'block';
    if (!lines.length) document.getElementById('empty-msg').textContent = 'Session log is empty.';
    statusEl.textContent = lines.length + ' events';
    document.getElementById('table-wrap').scrollTop = 0;
  } catch(e) { statusEl.textContent = 'Failed: ' + e.message; }
}

loadSessions();
</script>
</body>
</html>"""
    return HTMLResponse(content=html)
