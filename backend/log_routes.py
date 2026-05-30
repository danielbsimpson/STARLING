"""backend/log_routes.py — Read-only session log API endpoints.

Endpoints:
  GET  /log/sessions                  — list all session log files
  GET  /log/sessions/{session_id}     — return raw JSONL for a session
  POST /log/event                     — accept a frontend-originated event
  GET  /log/viewer                    — human-readable HTML log viewer
"""

import json
import math
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from pydantic import BaseModel, field_validator

import session_log

router = APIRouter(prefix="/log", tags=["log"])

# Session ID must match this pattern to prevent path traversal attacks.
_SESSION_ID_RE = re.compile(r"^session_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")

_ALLOWED_FRONTEND_EVENTS: frozenset[str] = frozenset({"tool_dispatch", "user_text", "user_speech_frontend", "error"})

from session_log import LOCALHOST_HOSTS as _LOCALHOST_HOSTS


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


@router.get("/stats/{session_id}")
def get_session_stats(session_id: str, request: Request):
    """Return pre-aggregated statistics for a session log. Localhost only."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id format.")

    path = session_log.LOG_DIR / f"{session_id}.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")

    event_counts: dict[str, int] = {}
    tools_used: list[str] = []
    _tools_seen: set[str] = set()
    session_start_ts: str | None = None
    session_end_ts: str | None = None

    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                event = record.get("event", "")
                event_counts[event] = event_counts.get(event, 0) + 1

                if event == "session_start" and session_start_ts is None:
                    session_start_ts = record.get("ts")
                if event == "session_end":
                    session_end_ts = record.get("ts")

                if event == "tool_dispatch":
                    tool = (record.get("data") or {}).get("tool")
                    if tool and tool not in _tools_seen:
                        _tools_seen.add(tool)
                        tools_used.append(tool)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not read session file: {exc}") from exc

    duration_s: float | None = None
    if session_start_ts and session_end_ts:
        try:
            start_dt = datetime.fromisoformat(session_start_ts)
            end_dt = datetime.fromisoformat(session_end_ts)
            duration_s = round((end_dt - start_dt).total_seconds(), 2)
        except ValueError:
            pass

    total_events = sum(event_counts.values())
    llm_calls = event_counts.get("llm_request", 0)
    tool_dispatches = event_counts.get("tool_dispatch", 0)
    error_count = event_counts.get("error", 0)

    return {
        "session_id": session_id,
        "total_events": total_events,
        "duration_s": duration_s,
        "llm_calls": llm_calls,
        "tool_dispatches": tool_dispatches,
        "error_count": error_count,
        "tools_used": tools_used,
        "event_counts": event_counts,
    }


def _iter_session_records(path: Path):
    """Yield parsed JSON records from a session log file, skipping bad lines."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def _duration_from_records(records: list[dict]) -> float | None:
    start_ts = end_ts = None
    for rec in records:
        if rec.get("event") == "session_start" and start_ts is None:
            start_ts = rec.get("ts")
        if rec.get("event") == "session_end":
            end_ts = rec.get("ts")
    if start_ts and end_ts:
        try:
            return round((datetime.fromisoformat(end_ts) - datetime.fromisoformat(start_ts)).total_seconds(), 2)
        except ValueError:
            return None
    return None


@router.get("/overview")
def log_overview(request: Request):
    """Cross-session aggregate health & metrics for the diagnostics dashboard.

    Scans up to the 50 most recent session logs and returns rolled-up totals,
    tool-usage frequency, error rate, and a sample of recent errors. Localhost only.
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    files = sorted(session_log.LOG_DIR.glob("*.jsonl"), reverse=True)[:50]

    total_sessions = len(files)
    total_events = 0
    total_llm_calls = 0
    total_tool_dispatches = 0
    total_errors = 0
    total_user_inputs = 0
    durations: list[float] = []
    tool_frequency: dict[str, int] = {}
    llm_durations: list[float] = []
    ttfts: list[float] = []
    tok_per_sec: list[float] = []
    completion_tokens: list[float] = []
    recent_errors: list[dict] = []
    current_session_id = session_log.get_session_id()

    for f in files:
        records = list(_iter_session_records(f))
        total_events += len(records)
        dur = _duration_from_records(records)
        if dur is not None:
            durations.append(dur)
        for rec in records:
            event = rec.get("event", "")
            data = rec.get("data") or {}
            if event == "llm_request":
                total_llm_calls += 1
            elif event == "llm_response":
                d = data.get("duration_ms")
                if isinstance(d, (int, float)):
                    llm_durations.append(d)
                if isinstance(data.get("ttft_ms"), (int, float)):
                    ttfts.append(data["ttft_ms"])
                if isinstance(data.get("predicted_per_second"), (int, float)):
                    tok_per_sec.append(data["predicted_per_second"])
                if isinstance(data.get("completion_tokens"), (int, float)):
                    completion_tokens.append(data["completion_tokens"])
            elif event == "tool_dispatch":
                total_tool_dispatches += 1
                tool = data.get("tool")
                if tool:
                    tool_frequency[tool] = tool_frequency.get(tool, 0) + 1
            elif event in ("user_speech", "user_speech_frontend", "user_text"):
                total_user_inputs += 1
            elif event == "error":
                total_errors += 1
                if len(recent_errors) < 25:
                    recent_errors.append({
                        "session_id": f.stem,
                        "ts": rec.get("ts"),
                        "source": data.get("source") or rec.get("source"),
                        "message": (data.get("message") or data.get("error") or "")[:200],
                    })

    avg_duration_s = round(sum(durations) / len(durations), 1) if durations else None
    avg_llm_ms = round(sum(llm_durations) / len(llm_durations)) if llm_durations else None
    avg_ttft_ms = round(sum(ttfts) / len(ttfts)) if ttfts else None
    avg_tok_per_sec = round(sum(tok_per_sec) / len(tok_per_sec), 1) if tok_per_sec else None
    total_completion_tokens = round(sum(completion_tokens)) if completion_tokens else 0
    error_rate = round(total_errors / total_events, 4) if total_events else 0.0

    top_tools = sorted(tool_frequency.items(), key=lambda kv: kv[1], reverse=True)

    # Live system health snapshot (best-effort; never block the dashboard).
    health: dict = {}
    try:
        import system_state
        health = system_state.sample_runtime_telemetry()
    except Exception:
        health = {}

    return {
        "total_sessions": total_sessions,
        "total_events": total_events,
        "total_llm_calls": total_llm_calls,
        "total_tool_dispatches": total_tool_dispatches,
        "total_user_inputs": total_user_inputs,
        "total_errors": total_errors,
        "error_rate": error_rate,
        "avg_session_duration_s": avg_duration_s,
        "avg_llm_duration_ms": avg_llm_ms,
        "avg_ttft_ms": avg_ttft_ms,
        "avg_tokens_per_sec": avg_tok_per_sec,
        "total_completion_tokens": total_completion_tokens,
        "tool_frequency": [{"tool": t, "count": c} for t, c in top_tools],
        "recent_errors": recent_errors,
        "system_health": health,
        "current_session_id": current_session_id,
    }


@router.get("/review/{session_id}")
def session_review(session_id: str, request: Request):
    """Deep per-session analysis: LLM output metrics, tool-call breakdown, and
    response reviews correlating each LLM reply with the tool calls injected
    before it. Localhost only.
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id format.")

    path = session_log.LOG_DIR / f"{session_id}.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")

    records = list(_iter_session_records(path))
    result = _analyze_records(records)
    result["session_id"] = session_id
    result["duration_s"] = _duration_from_records(records)

    # Merge any locally-judged quality scores (Phase 4) keyed by turn.
    evals = _load_evals(session_id)
    if evals:
        rel: list[float] = []
        coh: list[float] = []
        gnd: list[float] = []
        ov: list[float] = []
        for rv in result["reviews"]:
            ev = evals.get(str(rv.get("turn")))
            if not ev:
                continue
            rv["eval"] = ev
            for key, bucket in (("relevance", rel), ("coherence", coh),
                                ("groundedness", gnd), ("overall", ov)):
                v = ev.get(key)
                if isinstance(v, (int, float)):
                    bucket.append(v)

        def _avg(xs):
            return round(sum(xs) / len(xs), 2) if xs else None
        result["quality"] = {
            "count": len(ov),
            "avg_overall": _avg(ov),
            "avg_relevance": _avg(rel),
            "avg_coherence": _avg(coh),
            "avg_groundedness": _avg(gnd),
            "low_score_count": sum(1 for x in ov if x < 3),
        }
    return result


# Maximum review entries returned by a range query — keeps payloads bounded.
_MAX_RANGE_REVIEWS = 300

# Allowed time-window values (in days) for the range analysis endpoint.
_ALLOWED_RANGE_DAYS: frozenset[int] = frozenset({1, 2, 3, 4, 7, 30})


def _session_start_dt(path: Path) -> datetime | None:
    """Parse a session's start datetime (UTC) from its filename."""
    stem = path.stem  # session_YYYY-MM-DD_HH-MM-SS
    try:
        dt = datetime.strptime(stem, "session_%Y-%m-%d_%H-%M-%S")
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


@router.get("/review-range")
def session_review_range(request: Request, days: int = 1):
    """Aggregate analysis across all sessions started within the last ``days``
    days: combined LLM metrics, tool-call breakdown, and response reviews.
    Localhost only.
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")

    if days not in _ALLOWED_RANGE_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"days must be one of: {sorted(_ALLOWED_RANGE_DAYS)}",
        )

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    files = sorted(session_log.LOG_DIR.glob("*.jsonl"))

    # Collect, in chronological order, the records of every in-window session.
    combined: list[dict] = []
    session_ids: list[str] = []
    for f in files:
        start_dt = _session_start_dt(f)
        if start_dt is None or start_dt < cutoff:
            continue
        session_ids.append(f.stem)
        combined.extend(_iter_session_records(f))

    result = _analyze_records(combined, max_reviews=_MAX_RANGE_REVIEWS)
    result["days"] = days
    result["session_count"] = len(session_ids)
    result["session_ids"] = session_ids
    return result


def _percentile(sorted_vals: list, p: float):
    """Linear-interpolation percentile (p in 0..1). Returns None for empty input."""
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return round(sorted_vals[0], 1)
    k = (len(sorted_vals) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return round(sorted_vals[int(k)], 1)
    return round(sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f), 1)


def _stats(values: list) -> dict:
    if not values:
        return {"count": 0, "avg": None, "min": None, "max": None, "total": 0,
                "p50": None, "p95": None, "p99": None}
    sv = sorted(values)
    return {
        "count": len(values),
        "avg": round(sum(values) / len(values), 1),
        "min": round(min(values), 1),
        "max": round(max(values), 1),
        "total": round(sum(values), 1),
        "p50": _percentile(sv, 0.50),
        "p95": _percentile(sv, 0.95),
        "p99": _percentile(sv, 0.99),
    }


def _analyze_records(records: list[dict], max_reviews: int | None = None) -> dict:
    """Compute LLM metrics, tool-call breakdown, RAG metrics, response reviews,
    and anomaly flags from a chronological list of log records. Shared by the
    per-session and range analysis endpoints.

    When ``max_reviews`` is set, only the most recent that many reviews are
    returned (oldest are dropped) to keep range payloads bounded.
    """
    # ── LLM output metrics ────────────────────────────────────────────────────
    llm_durations: list[float] = []
    llm_tokens: list[int] = []        # legacy word-count estimate
    ttfts: list[float] = []
    tok_per_sec: list[float] = []
    prompt_tokens: list[int] = []
    completion_tokens: list[int] = []
    series: list[dict] = []
    for rec in records:
        if rec.get("event") != "llm_response":
            continue
        data = rec.get("data") or {}
        d = data.get("duration_ms")
        t = data.get("token_count_estimate")
        ttft = data.get("ttft_ms")
        tps = data.get("predicted_per_second")
        pt = data.get("prompt_tokens")
        ct = data.get("completion_tokens")
        if isinstance(d, (int, float)):
            llm_durations.append(d)
        if isinstance(t, (int, float)):
            llm_tokens.append(t)
        if isinstance(ttft, (int, float)):
            ttfts.append(ttft)
        if isinstance(tps, (int, float)):
            tok_per_sec.append(tps)
        if isinstance(pt, (int, float)):
            prompt_tokens.append(pt)
        if isinstance(ct, (int, float)):
            completion_tokens.append(ct)
        series.append({
            "ts": rec.get("ts"),
            "duration_ms": d if isinstance(d, (int, float)) else None,
            "ttft_ms": ttft if isinstance(ttft, (int, float)) else None,
            "tokens_per_sec": tps if isinstance(tps, (int, float)) else None,
            "completion_tokens": ct if isinstance(ct, (int, float)) else None,
        })
    if len(series) > 500:
        series = series[-500:]

    llm_metrics = {
        "duration_ms": _stats(llm_durations),
        "tokens": _stats(llm_tokens),
        "ttft_ms": _stats(ttfts),
        "tokens_per_sec": _stats(tok_per_sec),
        "prompt_tokens": _stats(prompt_tokens),
        "completion_tokens": _stats(completion_tokens),
    }

    # ── RAG metrics ───────────────────────────────────────────────────────────
    rag_buckets: dict[str, dict] = {}
    for rec in records:
        if rec.get("event") != "rag_retrieval":
            continue
        data = rec.get("data") or {}
        scope = data.get("scope") or "docs"
        b = rag_buckets.setdefault(scope, {"scope": scope, "retrievals": 0, "hits": [], "durations": [], "injected": 0})
        b["retrievals"] += 1
        if isinstance(data.get("hits"), (int, float)):
            b["hits"].append(data["hits"])
        if isinstance(data.get("duration_ms"), (int, float)):
            b["durations"].append(data["duration_ms"])
        if data.get("injected"):
            b["injected"] += 1
    rag_metrics = []
    for b in rag_buckets.values():
        hits = b.pop("hits")
        durs = b.pop("durations")
        b["avg_hits"] = round(sum(hits) / len(hits), 2) if hits else None
        b["avg_duration_ms"] = round(sum(durs) / len(durs), 1) if durs else None
        b["injection_rate"] = round(b["injected"] / b["retrievals"], 3) if b["retrievals"] else None
        rag_metrics.append(b)
    rag_metrics.sort(key=lambda e: e["retrievals"], reverse=True)

    # ── Tool-call breakdown (per endpoint) ────────────────────────────────────
    tool_stats: dict[str, dict] = {}
    for rec in records:
        event = rec.get("event")
        data = rec.get("data") or {}
        if event == "tool_dispatch":
            tool = data.get("tool") or "unknown"
            entry = tool_stats.setdefault(tool, {"tool": tool, "dispatches": 0, "calls": 0, "errors": 0, "silent_failures": 0, "durations": []})
            entry["dispatches"] += 1
        elif event == "tool_call":
            endpoint = data.get("endpoint") or "unknown"
            entry = tool_stats.setdefault(endpoint, {"tool": endpoint, "dispatches": 0, "calls": 0, "errors": 0, "silent_failures": 0, "durations": []})
            entry["calls"] += 1
        elif event == "tool_result":
            endpoint = data.get("endpoint") or "unknown"
            entry = tool_stats.setdefault(endpoint, {"tool": endpoint, "dispatches": 0, "calls": 0, "errors": 0, "silent_failures": 0, "durations": []})
            dur = data.get("duration_ms")
            if isinstance(dur, (int, float)):
                entry["durations"].append(dur)
            status = data.get("status_code")
            if isinstance(status, int) and status >= 400:
                entry["errors"] += 1
            else:
                # 2xx but empty/near-empty result = silent failure.
                summ = (data.get("result_summary") or "").strip()
                if isinstance(status, int) and status < 400 and len(summ) < 3:
                    entry["silent_failures"] += 1

    tool_breakdown = []
    for entry in tool_stats.values():
        durs = entry.pop("durations")
        sv = sorted(durs)
        entry["avg_duration_ms"] = round(sum(durs) / len(durs)) if durs else None
        entry["p95_duration_ms"] = _percentile(sv, 0.95) if durs else None
        denom = entry["calls"] or entry["dispatches"]
        entry["error_rate"] = round((entry["errors"] + entry["silent_failures"]) / denom, 3) if denom else 0.0
        tool_breakdown.append(entry)
    tool_breakdown.sort(key=lambda e: (e["dispatches"], e["calls"]), reverse=True)

    # ── Response reviews — correlate LLM replies with injected tool activity ──
    reviews: list[dict] = []
    pending_user = None
    pending_tools: list[str] = []
    pending_rag = 0
    for rec in records:
        event = rec.get("event")
        data = rec.get("data") or {}
        if event in ("user_speech", "user_speech_frontend", "user_text"):
            pending_user = (data.get("transcript") or data.get("text") or "")[:160]
            pending_tools = []
            pending_rag = 0
        elif event == "tool_dispatch":
            tool = data.get("tool")
            if tool:
                pending_tools.append(tool)
        elif event == "tool_result":
            ep = data.get("endpoint")
            if ep and ep not in pending_tools:
                pending_tools.append(ep)
        elif event == "rag_retrieval":
            pending_rag += int(data.get("hits") or 0)
        elif event == "llm_response":
            reviews.append({
                "ts": rec.get("ts"),
                "turn": rec.get("turn"),
                "user_input": pending_user,
                "injected_tools": list(pending_tools),
                "rag_hits": pending_rag,
                "response_excerpt": (data.get("full_text") or "")[:240],
                "duration_ms": data.get("duration_ms"),
                "ttft_ms": data.get("ttft_ms"),
                "tokens_per_sec": data.get("predicted_per_second"),
                "token_count": data.get("completion_tokens") or data.get("token_count_estimate"),
            })
            pending_tools = []
            pending_rag = 0

    # ── Anomaly detection ─────────────────────────────────────────────────────
    anomalies: list[dict] = []
    total_events = len(records)
    error_events = sum(1 for r in records if r.get("event") == "error")
    if total_events and error_events / total_events > 0.05:
        anomalies.append({
            "type": "high_error_rate", "severity": "bad",
            "message": f"Error rate {round(error_events / total_events * 100, 1)}% across {total_events} events",
        })
    dur_p50 = llm_metrics["duration_ms"]["p50"]
    dur_max = llm_metrics["duration_ms"]["max"]
    if dur_p50 and dur_max and dur_max > 3 * dur_p50:
        anomalies.append({
            "type": "latency_spike", "severity": "warn",
            "message": f"LLM latency spike: max {round(dur_max)}ms vs median {round(dur_p50)}ms",
        })
    tps_p50 = llm_metrics["tokens_per_sec"]["p50"]
    tps_min = llm_metrics["tokens_per_sec"]["min"]
    if tps_p50 and tps_min and tps_min < 0.4 * tps_p50:
        anomalies.append({
            "type": "throughput_drop", "severity": "warn",
            "message": f"Throughput drop: {round(tps_min, 1)} tok/s vs median {round(tps_p50, 1)} tok/s",
        })
    for t in tool_breakdown:
        if (t["calls"] or t["dispatches"]) >= 2 and t["error_rate"] >= 0.34:
            anomalies.append({
                "type": "tool_failures", "severity": "warn",
                "message": f"{t['tool']}: {round(t['error_rate'] * 100)}% failure rate",
            })
    # Loop detection — identical consecutive responses.
    loop_run = 1
    for i in range(1, len(reviews)):
        prev = (reviews[i - 1].get("response_excerpt") or "").strip()
        cur = (reviews[i].get("response_excerpt") or "").strip()
        if cur and cur == prev:
            loop_run += 1
            if loop_run == 3:
                anomalies.append({
                    "type": "response_loop", "severity": "warn",
                    "message": "Repeated identical responses detected (possible loop)",
                })
        else:
            loop_run = 1

    if max_reviews is not None and len(reviews) > max_reviews:
        reviews = reviews[-max_reviews:]

    return {
        "llm_metrics": llm_metrics,
        "tool_breakdown": tool_breakdown,
        "rag_metrics": rag_metrics,
        "series": series,
        "anomalies": anomalies,
        "reviews": reviews,
    }


def _parse_ts(ts) -> datetime | None:
    try:
        return datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None


# Span styling/type per source event for the trace timeline.
_SPAN_TYPES = {
    "user_speech": "stt", "user_speech_frontend": "stt", "user_text": "input",
    "rag_retrieval": "rag", "llm_response": "llm", "tool_result": "tool",
    "tts_synthesis": "tts", "error": "error",
}


def _build_traces(records: list[dict], max_turns: int = 100) -> list[dict]:
    """Group records by interaction ``turn`` and reconstruct each as a timeline
    of spans (STT → RAG → LLM → tools → TTS) for the trace waterfall view.
    """
    turns: dict[int, list[dict]] = {}
    for rec in records:
        turn = rec.get("turn")
        if isinstance(turn, int) and turn >= 1:
            turns.setdefault(turn, []).append(rec)

    traces: list[dict] = []
    for turn_id in sorted(turns):
        evs = [(d, e) for e in turns[turn_id] if (d := _parse_ts(e.get("ts")))]
        if not evs:
            continue
        evs.sort(key=lambda de: de[0])
        t_start = evs[0][0]
        spans: list[dict] = []
        user_input = None
        response_excerpt = None
        err_count = 0
        for d, e in evs:
            event = e.get("event")
            data = e.get("data") or {}
            end_off = (d - t_start).total_seconds() * 1000
            dur = data.get("duration_ms")
            dur = dur if isinstance(dur, (int, float)) else 0
            stype = _SPAN_TYPES.get(event)
            if event in ("user_speech", "user_speech_frontend", "user_text"):
                user_input = (data.get("transcript") or data.get("text") or "")[:200]
                label = "User text" if event == "user_text" else "Speech-to-text"
                spans.append({"type": stype, "label": label,
                              "start_ms": round(max(0.0, end_off - dur), 1), "duration_ms": dur,
                              "detail": {"device": data.get("device"), "language": data.get("language")}})
            elif event == "rag_retrieval":
                spans.append({"type": stype, "label": f"RAG · {data.get('scope', 'docs')}",
                              "start_ms": round(max(0.0, end_off - dur), 1), "duration_ms": dur,
                              "detail": {"hits": data.get("hits"), "sources": data.get("sources")}})
            elif event == "llm_response":
                response_excerpt = (data.get("full_text") or "")[:240]
                spans.append({"type": stype, "label": "LLM generation",
                              "start_ms": round(max(0.0, end_off - dur), 1), "duration_ms": dur,
                              "detail": {"ttft_ms": data.get("ttft_ms"),
                                         "tokens_per_sec": data.get("predicted_per_second"),
                                         "completion_tokens": data.get("completion_tokens"),
                                         "prompt_tokens": data.get("prompt_tokens")}})
            elif event == "tool_result":
                spans.append({"type": stype, "label": data.get("endpoint") or "tool",
                              "start_ms": round(max(0.0, end_off - dur), 1), "duration_ms": dur,
                              "detail": {"status_code": data.get("status_code")}})
            elif event == "tts_synthesis":
                spans.append({"type": stype, "label": "Text-to-speech",
                              "start_ms": round(max(0.0, end_off - dur), 1), "duration_ms": dur,
                              "detail": {"voice": data.get("voice"), "chunks": data.get("chunk_count")}})
            elif event == "error":
                err_count += 1
                spans.append({"type": "error", "label": "Error",
                              "start_ms": round(end_off, 1), "duration_ms": 0,
                              "detail": {"message": (data.get("message") or data.get("error") or "")[:160]}})
        total_ms = round(max((s["start_ms"] + s["duration_ms"] for s in spans), default=0.0), 1)
        traces.append({
            "turn": turn_id,
            "ts": evs[0][1].get("ts"),
            "user_input": user_input,
            "response_excerpt": response_excerpt,
            "total_ms": total_ms,
            "span_count": len(spans),
            "error_count": err_count,
            "spans": spans,
        })
    return traces[-max_turns:]


@router.get("/trace/{session_id}")
def session_trace(session_id: str, request: Request):
    """Per-session interaction traces (timeline of spans grouped by turn). Localhost only."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")
    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id format.")

    path = session_log.LOG_DIR / f"{session_id}.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")

    traces = _build_traces(list(_iter_session_records(path)))
    return {"session_id": session_id, "trace_count": len(traces), "traces": traces}


@router.get("/trace-range")
def trace_range(request: Request, days: int = 1):
    """Interaction traces aggregated across all sessions within the last ``days``. Localhost only."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")
    if days not in _ALLOWED_RANGE_DAYS:
        raise HTTPException(status_code=400, detail=f"days must be one of: {sorted(_ALLOWED_RANGE_DAYS)}")

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    all_traces: list[dict] = []
    for f in sorted(session_log.LOG_DIR.glob("*.jsonl")):
        start_dt = _session_start_dt(f)
        if start_dt is None or start_dt < cutoff:
            continue
        for tr in _build_traces(list(_iter_session_records(f))):
            tr["session_id"] = f.stem
            all_traces.append(tr)
    all_traces = all_traces[-200:]
    return {"days": days, "trace_count": len(all_traces), "traces": all_traces}


# ── Quality evaluation (local LLM-as-judge, Phase 4) ──────────────────────────
# Scores are stored in a sidecar file per session so re-scoring is incremental
# and historical sessions can be judged without touching the live session log.

_JUDGE_PROMPT = (
    "You are a strict evaluation judge for an AI voice assistant. Score the assistant's "
    "reply to the user on three axes from 1 (poor) to 5 (excellent):\n"
    "  relevance    — does it address what the user asked?\n"
    "  coherence    — is it clear, well-formed and consistent?\n"
    "  groundedness — is it supported by the provided context/tools? "
    "(use 3 if no context was needed)\n\n"
    "User said:\n{user}\n\n"
    "Context available to the assistant: {ctx}\n\n"
    "Assistant replied:\n{response}\n\n"
    "Respond with ONLY a compact JSON object, no prose:\n"
    '{{"relevance": <1-5>, "coherence": <1-5>, "groundedness": <1-5>, "notes": "<=12 words"}}'
)


def _evals_path(session_id: str) -> Path:
    return session_log.LOG_DIR / f"{session_id}.evals.json"


def _load_evals(session_id: str) -> dict:
    p = _evals_path(session_id)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_evals(session_id: str, evals: dict) -> None:
    try:
        _evals_path(session_id).write_text(json.dumps(evals, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


async def _judge_complete(prompt: str) -> str | None:
    """Run a single non-streaming completion on the local LLM backend."""
    backend = os.getenv("LLM_BACKEND", "ollama").lower()
    try:
        import httpx
        async with httpx.AsyncClient(timeout=60.0) as client:
            if backend == "llama":
                base = os.getenv("LLAMA_SERVER_URL", "http://localhost:8080")
                resp = await client.post(f"{base}/v1/chat/completions", json={
                    "model": os.getenv("LLAMA_MODEL", "llama3.1-8b"),
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0, "stream": False,
                })
                if resp.status_code == 200:
                    return resp.json()["choices"][0]["message"]["content"]
            else:
                base = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
                resp = await client.post(f"{base}/api/chat", json={
                    "model": os.getenv("OLLAMA_MODEL", "llama3.2:3b"),
                    "messages": [{"role": "user", "content": prompt}],
                    "options": {"temperature": 0.0}, "stream": False,
                })
                if resp.status_code == 200:
                    return resp.json()["message"]["content"]
    except Exception:
        return None
    return None


def _parse_score(text: str | None) -> dict | None:
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        raw = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    out: dict = {}
    vals: list[float] = []
    for key in ("relevance", "coherence", "groundedness"):
        v = raw.get(key)
        if isinstance(v, (int, float)):
            v = max(1, min(5, round(float(v), 1)))
            out[key] = v
            vals.append(v)
    if not vals:
        return None
    out["overall"] = round(sum(vals) / len(vals), 2)
    notes = raw.get("notes")
    if isinstance(notes, str):
        out["notes"] = notes[:120]
    return out


@router.post("/evaluate/{session_id}")
async def evaluate_session(session_id: str, request: Request, limit: int = 20):
    """Score a session's responses with the local model (LLM-as-judge). Incremental:
    only turns without an existing score are evaluated, up to ``limit``. Localhost only.
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")
    if not _SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session_id format.")
    limit = max(1, min(100, limit))

    path = session_log.LOG_DIR / f"{session_id}.jsonl"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found.")

    reviews = _analyze_records(list(_iter_session_records(path)))["reviews"]
    evals = _load_evals(session_id)
    scored = 0
    for rv in reviews:
        turn = rv.get("turn")
        if turn is None or str(turn) in evals:
            continue
        if not (rv.get("user_input") and rv.get("response_excerpt")):
            continue
        if scored >= limit:
            break
        ctx_bits = []
        if rv.get("rag_hits"):
            ctx_bits.append(f"{rv['rag_hits']} retrieved snippet(s)")
        if rv.get("injected_tools"):
            ctx_bits.append("tools: " + ", ".join(rv["injected_tools"][:5]))
        ctx = "; ".join(ctx_bits) or "none"
        prompt = _JUDGE_PROMPT.format(user=rv["user_input"], response=rv["response_excerpt"], ctx=ctx)
        score = _parse_score(await _judge_complete(prompt))
        if score:
            score["ts"] = rv.get("ts")
            evals[str(turn)] = score
            scored += 1
    _save_evals(session_id, evals)
    return {"session_id": session_id, "scored": scored, "total_evaluated": len(evals)}


@router.get("/versions")
def prompt_versions(request: Request, days: int = 7):
    """Group LLM performance by system-prompt hash across sessions in the last
    ``days`` so prompt changes can be correlated with metric shifts. Localhost only.
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Log endpoints are only accessible from localhost.")
    if days not in _ALLOWED_RANGE_DAYS:
        raise HTTPException(status_code=400, detail=f"days must be one of: {sorted(_ALLOWED_RANGE_DAYS)}")

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    buckets: dict[str, dict] = {}
    for f in sorted(session_log.LOG_DIR.glob("*.jsonl")):
        start_dt = _session_start_dt(f)
        if start_dt is None or start_dt < cutoff:
            continue
        current_hash = "unknown"
        for rec in _iter_session_records(f):
            event = rec.get("event")
            data = rec.get("data") or {}
            if event == "llm_request":
                current_hash = data.get("system_prompt_hash") or "unknown"
            elif event == "llm_response":
                b = buckets.setdefault(current_hash, {
                    "hash": current_hash, "responses": 0,
                    "durations": [], "ttfts": [], "tps": [],
                    "first_seen": rec.get("ts"), "last_seen": rec.get("ts"),
                })
                b["responses"] += 1
                b["last_seen"] = rec.get("ts")
                if isinstance(data.get("duration_ms"), (int, float)):
                    b["durations"].append(data["duration_ms"])
                if isinstance(data.get("ttft_ms"), (int, float)):
                    b["ttfts"].append(data["ttft_ms"])
                if isinstance(data.get("predicted_per_second"), (int, float)):
                    b["tps"].append(data["predicted_per_second"])

    versions = []
    for b in buckets.values():
        durs = b.pop("durations")
        ttfts = b.pop("ttfts")
        tps = b.pop("tps")
        b["avg_duration_ms"] = round(sum(durs) / len(durs)) if durs else None
        b["avg_ttft_ms"] = round(sum(ttfts) / len(ttfts)) if ttfts else None
        b["avg_tokens_per_sec"] = round(sum(tps) / len(tps), 1) if tps else None
        versions.append(b)
    versions.sort(key=lambda v: v["last_seen"] or "", reverse=True)
    return {"days": days, "version_count": len(versions), "versions": versions}


@router.get("/viewer")
def log_viewer():
    """Redirect to the standalone log dashboard page."""
    return RedirectResponse(url="/log-dashboard.html", status_code=302)
