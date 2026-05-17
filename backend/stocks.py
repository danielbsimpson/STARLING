"""
backend/stocks.py

Enhanced market data module — Tool 5, all enhancements.
- JSON watchlist file  (memory/watchlist.json)
- Persistent on-disk quote + history cache  (memory/stocks_cache.json)
- Historical OHLCV data with gap-fill  (memory/stocks_history.json)
- GET  /stocks/watchlist          — return / update watchlist
- GET  /stocks/history            — per-ticker OHLCV with gap-fill
- GET  /stocks/history/batch      — multiple tickers at once
- GET  /stocks/briefing           — pre-built LLM context for a single ticker
- GET  /stocks/cache/status       — per-ticker freshness info
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yfinance as yf
from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Query

router = APIRouter()
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
_BASE_DIR       = Path(__file__).parent
_WATCHLIST_FILE = _BASE_DIR / os.getenv("STOCKS_WATCHLIST_FILE", "memory/watchlist.json")
_CACHE_FILE     = _BASE_DIR / os.getenv("STOCKS_CACHE_FILE",     "memory/stocks_cache.json")
_HISTORY_FILE   = _BASE_DIR / os.getenv("STOCKS_HISTORY_FILE",   "memory/stocks_history.json")
_CURRENCY_SYM   = os.getenv("STOCKS_CURRENCY_SYMBOL", "$")

# ── Constants ─────────────────────────────────────────────────────────────────
_NYSE_TZ   = ZoneInfo("America/New_York")
_QUOTE_TTL = 3600  # 1 hour per-ticker quote cache TTL

# Window → (yf_period, yf_interval, cache_ttl_seconds)
_WINDOW_MAP = {
    "7d":  ("7d",  "1h",  300),
    "1m":  ("1mo", "1d",  900),
    "3m":  ("3mo", "1d",  3600),
    "6m":  ("6mo", "1d",  3600),
    "1y":  ("1y",  "1wk", 21600),
    "5y":  ("5y",  "1wk", 21600),
    "10y": ("10y", "1mo", 86400),
}

_DEFAULT_WATCHLIST = {
    "default_group": "all",
    "groups": [
        {"label": "Indices", "tickers": ["^GSPC", "^IXIC", "^DJI"]},
        {"label": "Tech",    "tickers": ["NVDA", "AAPL", "MSFT", "SPY", "QQQ"]},
        {"label": "Crypto",  "tickers": ["BTC-USD", "ETH-USD", "SOL-USD"]},
        {"label": "Personal","tickers": []},
    ],
}


# ── Helpers — atomic file I/O ─────────────────────────────────────────────────

def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _load_json(path: Path, default: dict) -> dict:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("JSON load error (%s): %s", path.name, exc)
    return dict(default)


# ── Watchlist helpers ─────────────────────────────────────────────────────────

def _ensure_watchlist() -> None:
    if not _WATCHLIST_FILE.exists():
        _atomic_write(_WATCHLIST_FILE, _DEFAULT_WATCHLIST)


def _load_watchlist() -> dict:
    _ensure_watchlist()
    return _load_json(_WATCHLIST_FILE, _DEFAULT_WATCHLIST)


def _flat_tickers(watchlist: dict) -> list:
    seen, out = set(), []
    for g in watchlist.get("groups", []):
        for sym in g.get("tickers", []):
            if sym not in seen:
                seen.add(sym)
                out.append(sym)
    return out


# ── Quote cache ───────────────────────────────────────────────────────────────

def _load_quote_cache() -> dict:
    return _load_json(_CACHE_FILE, {"quote": {}})


def _save_quote_cache(cache: dict) -> None:
    _atomic_write(_CACHE_FILE, cache)


def _cached_quote(symbol: str) -> dict | None:
    disk  = _load_quote_cache()
    entry = disk["quote"].get(symbol)
    if entry and (time.time() - entry.get("fetched_ts", 0)) < _QUOTE_TTL:
        return entry["data"]
    return None


def _store_quote(symbol: str, data: dict) -> None:
    disk = _load_quote_cache()
    disk.setdefault("quote", {})[symbol] = {
        "fetched_ts": time.time(),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "data":       data,
    }
    _save_quote_cache(disk)


# ── History file helpers ──────────────────────────────────────────────────────

def _load_history_store() -> dict:
    return _load_json(_HISTORY_FILE, {})


def _save_history_store(store: dict) -> None:
    _atomic_write(_HISTORY_FILE, store)


def _df_to_candles(df) -> list:
    if df is None or df.empty:
        return []
    candles = []
    for ts, row in df.iterrows():
        try:
            t_ms = int(ts.timestamp() * 1000) if hasattr(ts, "timestamp") else int(ts) // 1_000_000
            candles.append({
                "t": t_ms,
                "o": round(float(row.get("Open",   row.get("open",   0)) or 0), 4),
                "h": round(float(row.get("High",   row.get("high",   0)) or 0), 4),
                "l": round(float(row.get("Low",    row.get("low",    0)) or 0), 4),
                "c": round(float(row.get("Close",  row.get("close",  0)) or 0), 4),
                "v": int(row.get("Volume", row.get("volume", 0)) or 0),
            })
        except Exception as exc:
            print(f"[stocks] candle parse error: {exc}")
    return candles


def _fetch_history_raw(symbol: str, period: str, interval: str) -> list:
    try:
        df = yf.Ticker(symbol).history(period=period, interval=interval, auto_adjust=True)
        return _df_to_candles(df)
    except Exception as exc:
        print(f"[stocks] history fetch error {symbol} {period}: {exc}")
        return []


def _history_with_gap_fill(symbol: str, window: str, force: bool = False) -> list:
    """Load stored candles; fetch only the gap since last candle; merge & persist."""
    cfg = _WINDOW_MAP.get(window)
    if not cfg:
        raise ValueError(f"Unknown window: {window}")
    period, interval, ttl = cfg

    store  = _load_history_store()
    key    = f"{symbol}__{window}"
    entry  = store.get(key, {})
    stored = entry.get("candles", [])
    ts     = entry.get("fetched_ts", 0)

    if stored and (time.time() - ts) < ttl and not force:
        return stored

    if stored and not force:
        last_ms  = stored[-1]["t"]
        from datetime import datetime as _dt
        start    = _dt.fromtimestamp(last_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        try:
            df       = yf.Ticker(symbol).history(start=start, interval=interval, auto_adjust=True)
            new_c    = _df_to_candles(df)
        except Exception as exc:
            print(f"[stocks] gap-fill error {symbol} {window}: {exc}")
            new_c    = []
        existing = {c["t"] for c in stored}
        merged   = stored + [c for c in new_c if c["t"] not in existing]
        merged.sort(key=lambda c: c["t"])
    else:
        merged = _fetch_history_raw(symbol, period, interval)

    if merged:
        store[key] = {
            "fetched_ts": time.time(),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "interval":   interval,
            "candles":    merged,
        }
        _save_history_store(store)
    return merged


def _prefill_all_windows(symbol: str) -> None:
    for win in _WINDOW_MAP:
        try:
            _history_with_gap_fill(symbol, win)
        except Exception as exc:
            print(f"[stocks] prefill error {symbol} {win}: {exc}")


# ── Market hours ──────────────────────────────────────────────────────────────

def _is_us_market_open() -> bool:
    now   = datetime.now(_NYSE_TZ)
    if now.weekday() >= 5:
        return False
    open_ = now.replace(hour=9,  minute=30, second=0, microsecond=0)
    close = now.replace(hour=16, minute=0,  second=0, microsecond=0)
    return open_ <= now <= close


# ── Formatting ────────────────────────────────────────────────────────────────

def _fmt_price(val, sym: str = "$") -> str:
    if val is None:
        return "—"
    if val >= 1_000:
        return f"{sym}{val:,.2f}"
    if val >= 1:
        return f"{sym}{val:.2f}"
    return f"{sym}{val:.4f}"


def _fmt_change(chg, pct) -> dict:
    if chg is None or pct is None:
        return {"value": "—", "pct": "—", "direction": "flat"}
    direction = "up" if pct > 0 else "down" if pct < 0 else "flat"
    return {
        "value":     f"{'+' if chg >= 0 else ''}{abs(chg):.4f}".rstrip("0").rstrip("."),
        "pct":       f"{'+' if pct >= 0 else ''}{pct:.2f}%",
        "direction": direction,
    }


def _fmt_large(val) -> str:
    if val is None:
        return "—"
    if val >= 1e12:
        return f"{val / 1e12:.2f}T"
    if val >= 1e9:
        return f"{val / 1e9:.2f}B"
    if val >= 1e6:
        return f"{val / 1e6:.2f}M"
    return f"{val:,.0f}"


def _ticker_type(symbol: str) -> str:
    s = symbol.upper()
    if s.endswith("-USD") or s.endswith("-USDT") or s.endswith("-BTC"):
        return "crypto"
    if s.endswith("=X"):
        return "forex"
    if s.startswith("^"):
        return "index"
    return "equity"


# ── Single ticker fetch (with disk cache) ─────────────────────────────────────

def _fetch_ticker(symbol: str) -> dict | None:
    cached = _cached_quote(symbol)
    if cached:
        return cached

    try:
        t    = yf.Ticker(symbol)
        info = t.fast_info

        price = info.last_price
        prev  = info.previous_close
        if price is None:
            return None

        chg = (price - prev) if prev else None
        pct = ((price - prev) / prev * 100) if prev else None

        name = (
            getattr(info, "display_name", None)
            or symbol.replace("-USD", "").replace("=X", "").replace("^", "")
        )

        week52_low  = getattr(info, "year_low",  None)
        week52_high = getattr(info, "year_high", None)
        sym_char    = "" if symbol.startswith("^") else _CURRENCY_SYM

        data = {
            "symbol":      symbol,
            "name":        name,
            "type":        _ticker_type(symbol),
            "price":       price,
            "price_fmt":   _fmt_price(price, sym_char),
            "prev_close":  prev,
            "change":      _fmt_change(chg, pct),
            "pct_raw":     round(pct, 2) if pct is not None else None,
            "week52_low":  _fmt_price(week52_low,  sym_char),
            "week52_high": _fmt_price(week52_high, sym_char),
            "volume":      _fmt_large(getattr(info, "three_month_average_volume", None)),
            "market_cap":  _fmt_large(getattr(info, "market_cap", None)),
            "currency":    getattr(info, "currency", "USD"),
        }
        _store_quote(symbol, data)
        return data
    except Exception as exc:
        print(f"[stocks] failed to fetch {symbol}: {exc}")
        return None


# ── LLM context builders ──────────────────────────────────────────────────────

def _build_llm_context(tickers: list, market_open: bool) -> str:
    now_et   = datetime.now(_NYSE_TZ)
    hour_str = str(now_et.hour % 12 or 12)
    ampm     = "AM" if now_et.hour < 12 else "PM"
    day_name = now_et.strftime("%A")
    month    = now_et.strftime("%B")
    day      = str(now_et.day)

    session_label = (
        f"Markets are currently open ({hour_str}:{now_et.strftime('%M')} {ampm} ET)."
        if market_open else
        f"Markets are closed. Showing last close prices ({day_name}, {month} {day})."
    )

    equities = [t for t in tickers if t["type"] in ("equity", "index", "etf")]
    cryptos  = [t for t in tickers if t["type"] == "crypto"]

    lines = [
        f"[MARKET DATA — {hour_str}:{now_et.strftime('%M')} {ampm} ET, {day_name} {month} {day}]",
        session_label,
    ]
    if equities:
        lines.append("Equities and indices:")
        for t in equities:
            lines.append(f"  {t['symbol']}: {t['price_fmt']}  {t['change']['pct']} ({t['change']['direction']})")
    if cryptos:
        lines.append("Crypto:")
        for t in cryptos:
            label = t["symbol"].replace("-USD", "").replace("-USDT", "")
            lines.append(f"  {label}: {t['price_fmt']}  {t['change']['pct']} ({t['change']['direction']})")

    movers = sorted(
        [t for t in tickers if t["pct_raw"] is not None and abs(t["pct_raw"]) >= 2.0],
        key=lambda x: abs(x["pct_raw"]), reverse=True,
    )
    if movers:
        mover_strs = [f"{t['symbol']} {'+' if t['pct_raw'] > 0 else ''}{t['pct_raw']:.1f}%" for t in movers[:4]]
        lines.append(f"Notable movers: {', '.join(mover_strs)}.")

    return "\n".join(lines)


def _build_briefing_context(symbol: str, window: str, quote: dict, candles: list, market_open: bool | None = None) -> str:
    if market_open is None:
        market_open = _is_us_market_open()

    now_et   = datetime.now(_NYSE_TZ)
    hour_str = str(now_et.hour % 12 or 12)
    ampm     = "AM" if now_et.hour < 12 else "PM"
    day_name = now_et.strftime("%A")
    month    = now_et.strftime("%B")
    day      = str(now_et.day)

    name     = quote.get("name", symbol)
    price    = quote.get("price_fmt", "—")
    chg_pct  = quote.get("change", {}).get("pct", "—")
    chg_dir  = quote.get("change", {}).get("direction", "flat")
    w52_high = quote.get("week52_high", "—")
    w52_low  = quote.get("week52_low",  "—")

    win_perf = "—"
    if len(candles) >= 2:
        fc, lc = candles[0]["c"], candles[-1]["c"]
        if fc:
            wp       = (lc - fc) / fc * 100
            win_perf = f"{'+' if wp >= 0 else ''}{wp:.1f}%"

    high_c = max((c["h"] for c in candles), default=None)
    low_c  = min((c["l"] for c in candles), default=None)

    win_label = {
        "7d": "the past week",     "1m": "the past month",
        "3m": "the past 3 months", "6m": "the past 6 months",
        "1y": "the past year",     "5y": "the past 5 years",
        "10y": "the past 10 years",
    }.get(window, window)

    is_crypto    = _ticker_type(symbol) == "crypto"
    change_label = "Change today" if market_open or is_crypto else "Change (last close)"

    if is_crypto:
        market_note = f"Crypto markets trade 24/7. Current time: {hour_str}:{now_et.strftime('%M')} {ampm} ET."
    elif market_open:
        market_note = f"US equity markets are OPEN ({hour_str}:{now_et.strftime('%M')} {ampm} ET). Prices are live."
    else:
        market_note = (
            f"US equity markets are CLOSED. Prices shown are from the most recent close "
            f"({day_name}, {month} {day}). Current time: {hour_str}:{now_et.strftime('%M')} {ampm} ET."
        )

    sym_char = "" if symbol.startswith("^") else _CURRENCY_SYM
    lines = [
        f"[TICKER BRIEFING — {symbol} — {hour_str}:{now_et.strftime('%M')} {ampm} ET, {day_name} {month} {day}]",
        market_note,
        f"Name: {name}",
        f"Current price: {price}  {change_label}: {chg_pct} ({chg_dir})",
        f"Performance over {win_label}: {win_perf}",
        f"52-week range: {w52_low} – {w52_high}",
    ]
    if high_c and low_c:
        lines.append(f"Window high: {_fmt_price(high_c, sym_char)}  Window low: {_fmt_price(low_c, sym_char)}")
    lines.append(
        "Provide a concise spoken briefing in under 60 words. "
        "Be factual and conversational. Do not give financial advice."
    )
    return "\n".join(lines)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/stocks/watchlist")
async def get_watchlist():
    return _load_watchlist()


@router.put("/stocks/watchlist")
async def put_watchlist(body: dict = Body(...)):
    groups = body.get("groups")
    if not isinstance(groups, list):
        raise HTTPException(status_code=400, detail="'groups' must be a list")
    for g in groups:
        if not isinstance(g.get("label"), str) or not isinstance(g.get("tickers"), list):
            raise HTTPException(status_code=400, detail="Each group needs 'label' (str) and 'tickers' (list)")
    _atomic_write(_WATCHLIST_FILE, body)
    _atomic_write(_CACHE_FILE, {"quote": {}})
    return {"status": "saved", "groups": len(groups)}


@router.get("/stocks")
async def get_stocks():
    """Return live price data grouped by watchlist; backward-compat flat 'tickers' + 'llm_context' included."""
    watchlist = _load_watchlist()
    symbols   = _flat_tickers(watchlist)

    loop    = asyncio.get_event_loop()
    results = await asyncio.gather(
        *[loop.run_in_executor(None, _fetch_ticker, sym) for sym in symbols],
        return_exceptions=True,
    )

    ticker_map: dict = {}
    failed: list     = []
    for sym, r in zip(symbols, results):
        if isinstance(r, dict):
            ticker_map[sym] = r
        else:
            failed.append(sym)

    groups_out = []
    for g in watchlist.get("groups", []):
        group_tickers = [ticker_map[sym] for sym in g["tickers"] if sym in ticker_map]
        groups_out.append({"label": g["label"], "tickers": group_tickers})

    flat = [ticker_map[s] for s in symbols if s in ticker_map]
    market_open = _is_us_market_open()

    return {
        "groups":        groups_out,
        "default_group": watchlist.get("default_group", "all"),
        "tickers":       flat,           # backward compat
        "failed":        failed,
        "total":         len(flat),
        "market_open":   market_open,
        "llm_context":   _build_llm_context(flat, market_open),
        "fetched_at":    datetime.now(timezone.utc).isoformat(),
        "currency_sym":  _CURRENCY_SYM,
    }


@router.get("/stocks/cache/status")
async def get_cache_status():
    disk = _load_quote_cache()
    now  = time.time()
    result = {}
    for sym, entry in disk.get("quote", {}).items():
        age = int(now - entry.get("fetched_ts", 0))
        result[sym] = {"fetched_at": entry.get("fetched_at"), "age_seconds": age, "stale": age > _QUOTE_TTL}
    return result


@router.delete("/stocks/cache")
async def bust_stocks_cache():
    """Clear the on-disk quote cache; next GET /stocks fetches live data."""
    _atomic_write(_CACHE_FILE, {"quote": {}})
    return {"status": "cleared"}


@router.get("/stocks/history")
async def get_stock_history(
    ticker: str  = Query(...),
    window: str  = Query("1m"),
    force:  bool = Query(False),
    background_tasks: BackgroundTasks = None,
):
    if window not in _WINDOW_MAP:
        raise HTTPException(status_code=400, detail=f"Invalid window '{window}'. Choose from: {list(_WINDOW_MAP)}")

    loop    = asyncio.get_event_loop()
    candles = await loop.run_in_executor(None, _history_with_gap_fill, ticker, window, force)

    store = _load_history_store()
    entry = store.get(f"{ticker}__{window}", {})

    if background_tasks:
        background_tasks.add_task(_prefill_all_windows, ticker)

    return {
        "ticker":     ticker,
        "window":     window,
        "interval":   _WINDOW_MAP[window][1],
        "candles":    candles,
        "count":      len(candles),
        "fetched_at": entry.get("fetched_at"),
    }


@router.get("/stocks/history/batch")
async def get_history_batch(
    tickers: str  = Query(..., description="Comma-separated ticker symbols"),
    window:  str  = Query("1m"),
    force:   bool = Query(False),
):
    if window not in _WINDOW_MAP:
        raise HTTPException(status_code=400, detail=f"Invalid window '{window}'")

    symbols = [s.strip() for s in tickers.split(",") if s.strip()]
    if not symbols:
        raise HTTPException(status_code=400, detail="No tickers provided")

    loop    = asyncio.get_event_loop()
    results = await asyncio.gather(
        *[loop.run_in_executor(None, _history_with_gap_fill, sym, window, force) for sym in symbols],
        return_exceptions=True,
    )

    store = _load_history_store()
    out   = []
    for sym, r in zip(symbols, results):
        entry = store.get(f"{sym}__{window}", {})
        if isinstance(r, list):
            out.append({
                "ticker":     sym,
                "window":     window,
                "interval":   _WINDOW_MAP[window][1],
                "candles":    r,
                "count":      len(r),
                "fetched_at": entry.get("fetched_at"),
            })
        else:
            out.append({"ticker": sym, "window": window, "candles": [], "count": 0, "error": str(r)})
    return out


@router.get("/stocks/briefing")
async def get_briefing(
    ticker: str = Query(...),
    window: str = Query("1m"),
):
    loop         = asyncio.get_event_loop()
    quote_task   = loop.run_in_executor(None, _fetch_ticker, ticker)
    candles_task = loop.run_in_executor(None, _history_with_gap_fill, ticker, window, False)
    quote, candles = await asyncio.gather(quote_task, candles_task)

    if not isinstance(quote, dict):
        raise HTTPException(status_code=502, detail=f"Could not fetch quote for {ticker}")

    market_open = _is_us_market_open()
    return {
        "ticker":      ticker,
        "window":      window,
        "market_open": market_open,
        "llm_context": _build_briefing_context(ticker, window, quote, candles, market_open),
    }


@router.delete("/stocks/history")
async def delete_history(
    ticker: str = Query(None),
    window: str = Query(None),
):
    store   = _load_history_store()
    deleted = []
    if ticker and window:
        key = f"{ticker}__{window}"
        if key in store:
            del store[key]
            deleted.append(key)
    elif ticker:
        keys = [k for k in store if k.startswith(f"{ticker}__")]
        for k in keys:
            del store[k]
        deleted.extend(keys)
    else:
        deleted = list(store.keys())
        store   = {}
    _save_history_store(store)
    return {"status": "deleted", "keys": deleted}
