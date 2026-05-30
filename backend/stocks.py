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
import session_log

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
    "my_stocks": [
        {"symbol": "AAPL", "shares": 10},
        {"symbol": "MSFT", "shares": 5},
        {"symbol": "NVDA", "shares": 8},
    ],
    "my_crypto": [
        {"symbol": "BTC-USD", "shares": 0.25},
        {"symbol": "ETH-USD", "shares": 2},
    ],
    "profile": {
        "age":               "",
        "risk_profile":      "Moderate",
        "time_horizon":      "",
        "primary_goal":      "",
        "available_capital": "",
    },
}

_PROFILE_FIELDS = ("age", "risk_profile", "time_horizon", "primary_goal", "available_capital")


# ── Helpers — atomic file I/O ─────────────────────────────────────────────────
from file_utils import atomic_write_json as _atomic_write


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
    wl = _load_json(_WATCHLIST_FILE, _DEFAULT_WATCHLIST)
    # Migrate older watchlist files that predate the My Stocks / My Crypto holdings.
    changed = False
    if "my_stocks" not in wl:
        wl["my_stocks"] = _derive_holdings(wl, equity=True)
        changed = True
    if "my_crypto" not in wl:
        wl["my_crypto"] = _derive_holdings(wl, equity=False)
        changed = True
    if "profile" not in wl or not isinstance(wl.get("profile"), dict):
        wl["profile"] = dict(_DEFAULT_WATCHLIST["profile"])
        changed = True
    else:
        for f in _PROFILE_FIELDS:
            if f not in wl["profile"]:
                wl["profile"][f] = _DEFAULT_WATCHLIST["profile"][f]
                changed = True
    if changed:
        _atomic_write(_WATCHLIST_FILE, wl)
    return wl


def _derive_holdings(watchlist: dict, equity: bool) -> list:
    """Seed holdings from existing watchlist tickers (shares default to 1)."""
    out, seen = [], set()
    for sym in _flat_tickers(watchlist):
        is_crypto = _ticker_type(sym) == "crypto"
        is_index  = _ticker_type(sym) == "index"
        if is_index:
            continue
        if equity and is_crypto:
            continue
        if not equity and not is_crypto:
            continue
        if sym in seen:
            continue
        seen.add(sym)
        out.append({"symbol": sym, "shares": 1})
        if len(out) >= 8:
            break
    if out:
        return out
    fallback = "my_crypto" if not equity else "my_stocks"
    return [dict(h) for h in _DEFAULT_WATCHLIST.get(fallback, [])]


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


# ── Fundamentals fetch (P/E, ROE, D/E, FCF) — disk cached ─────────────────────
_FUNDAMENTALS_TTL = 86_400  # 24h — fundamentals change slowly


def _cached_fundamentals(symbol: str) -> dict | None:
    disk  = _load_quote_cache()
    entry = disk.get("fundamentals", {}).get(symbol)
    if entry and (time.time() - entry.get("fetched_ts", 0)) < _FUNDAMENTALS_TTL:
        return entry["data"]
    return None


def _store_fundamentals(symbol: str, data: dict) -> None:
    disk = _load_quote_cache()
    disk.setdefault("fundamentals", {})[symbol] = {
        "fetched_ts": time.time(),
        "data":       data,
    }
    _save_quote_cache(disk)


def _fetch_fundamentals(symbol: str) -> dict:
    """Return P/E, ROE, D/E, FCF for an equity. Crypto/indices return empty.

    Uses yfinance .info (slower than fast_info) and caches for 24h."""
    if _ticker_type(symbol) != "equity":
        return {}

    cached = _cached_fundamentals(symbol)
    if cached is not None:
        return cached

    fundamentals: dict = {}
    try:
        info = yf.Ticker(symbol).info or {}
        pe   = info.get("trailingPE")
        roe  = info.get("returnOnEquity")      # fraction, e.g. 0.45 → 45%
        de   = info.get("debtToEquity")        # often expressed as percent, e.g. 195 → 1.95
        fcf  = info.get("freeCashflow")

        fundamentals = {
            "pe":  round(float(pe), 2)                      if pe  is not None else None,
            "roe": round(float(roe) * 100, 1)              if roe is not None else None,
            "de":  round(float(de) / 100, 2)               if de  is not None else None,
            "fcf": _fmt_large(float(fcf))                  if fcf is not None else None,
        }
    except Exception as exc:
        print(f"[stocks] fundamentals fetch error {symbol}: {exc}")
        fundamentals = {}

    _store_fundamentals(symbol, fundamentals)
    return fundamentals


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


# ── Holdings (My Stocks / My Crypto) ──────────────────────────────────────────

def _clean_holdings(items) -> list:
    out, seen = [], set()
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        sym = str(it.get("symbol", "")).strip().upper()
        if not sym or sym in seen:
            continue
        try:
            shares = float(it.get("shares", 0) or 0)
        except (TypeError, ValueError):
            shares = 0.0
        if shares < 0:
            shares = 0.0
        seen.add(sym)
        out.append({"symbol": sym, "shares": shares})
    return out


@router.get("/stocks/holdings")
async def get_holdings():
    wl = _load_watchlist()
    return {
        "my_stocks": wl.get("my_stocks", []),
        "my_crypto": wl.get("my_crypto", []),
        "profile":   wl.get("profile", dict(_DEFAULT_WATCHLIST["profile"])),
        "currency_sym": _CURRENCY_SYM,
    }


def _clean_profile(raw) -> dict:
    out = dict(_DEFAULT_WATCHLIST["profile"])
    if isinstance(raw, dict):
        for f in _PROFILE_FIELDS:
            if f in raw and raw[f] is not None:
                out[f] = str(raw[f]).strip()
    return out


@router.put("/stocks/holdings")
async def put_holdings(body: dict = Body(...)):
    wl = _load_watchlist()
    if "my_stocks" in body:
        wl["my_stocks"] = _clean_holdings(body.get("my_stocks"))
    if "my_crypto" in body:
        wl["my_crypto"] = _clean_holdings(body.get("my_crypto"))
    if "profile" in body:
        wl["profile"] = _clean_profile(body.get("profile"))
    _atomic_write(_WATCHLIST_FILE, wl)
    _atomic_write(_CACHE_FILE, {"quote": {}})  # force fresh quotes for any new symbols
    return {
        "status":    "saved",
        "my_stocks": len(wl.get("my_stocks", [])),
        "my_crypto": len(wl.get("my_crypto", [])),
    }


def _portfolio_series(holdings: list, window: str, force: bool = False) -> list:
    """Combined value-over-time: sum(shares_i * price_i(t)) across holdings.

    Timestamps are unioned; each ticker's last-known close is carried forward.
    Leading timestamps are skipped until every holding has at least one price."""
    per: dict = {}
    for h in holdings:
        sym    = h["symbol"]
        shares = float(h.get("shares") or 0)
        candles = _history_with_gap_fill(sym, window, force)
        per[sym] = (shares, {c["t"]: c["c"] for c in candles})

    if not per:
        return []

    all_ts = sorted({t for _, m in per.values() for t in m})
    last   = {sym: None for sym in per}
    out    = []
    for t in all_ts:
        for sym, (_, m) in per.items():
            if t in m:
                last[sym] = m[t]
        if any(v is None for v in last.values()):
            continue  # wait until every holding has a price
        total = sum(shares * last[sym] for sym, (shares, _) in per.items())
        out.append({"t": t, "c": round(total, 2)})
    return out


@router.get("/stocks/portfolio/history")
async def get_portfolio_history(
    kind:   str  = Query("stocks", description="'stocks' or 'crypto'"),
    window: str  = Query("1m"),
    force:  bool = Query(False),
):
    if window not in _WINDOW_MAP:
        raise HTTPException(status_code=400, detail=f"Invalid window '{window}'")

    wl       = _load_watchlist()
    key      = "my_crypto" if kind == "crypto" else "my_stocks"
    holdings = [h for h in wl.get(key, []) if float(h.get("shares") or 0) != 0]

    loop    = asyncio.get_running_loop()
    candles = await loop.run_in_executor(None, _portfolio_series, holdings, window, force)

    # Current total value from live quotes.
    quotes = await asyncio.gather(
        *[loop.run_in_executor(None, _fetch_ticker, h["symbol"]) for h in holdings],
        return_exceptions=True,
    )
    total = 0.0
    for h, q in zip(holdings, quotes):
        if isinstance(q, dict) and q.get("price") is not None:
            total += float(h.get("shares") or 0) * q["price"]

    chg = pct = None
    if len(candles) >= 2 and candles[0]["c"]:
        first, lastc = candles[0]["c"], candles[-1]["c"]
        chg = lastc - first
        pct = (chg / first * 100) if first else None

    return {
        "kind":       kind,
        "window":     window,
        "candles":    candles,
        "count":      len(candles),
        "total":      round(total, 2),
        "total_fmt":  _fmt_price(total, _CURRENCY_SYM),
        "change":     _fmt_change(chg, pct),
        "holdings":   holdings,
    }


def _build_portfolio_analysis_context(
    profile: dict,
    rows: list,
    grand_total: float,
    market_open: bool,
) -> str:
    """Build the PORTFOLIO DATA block appended to the analyst persona prompt.

    `rows` is a list of dicts: {symbol, type, shares, price, value, fundamentals}."""
    import prompts

    now_et   = datetime.now(_NYSE_TZ)
    hour_str = str(now_et.hour % 12 or 12)
    ampm     = "AM" if now_et.hour < 12 else "PM"
    day_name = now_et.strftime("%A")
    month    = now_et.strftime("%B")
    day      = str(now_et.day)

    persona = prompts.get("STOCKS_PORTFOLIO_ANALYST")

    lines = [
        f"[PORTFOLIO DATA — auto-generated from saved settings, "
        f"{hour_str}:{now_et.strftime('%M')} {ampm} ET, {day_name} {month} {day}]",
    ]

    # Investor profile
    lines.append("")
    lines.append("INVESTOR PROFILE:")
    lines.append(f"- Age: {profile.get('age') or 'not provided'}")
    lines.append(f"- Risk Profile: {profile.get('risk_profile') or 'not provided'}")
    lines.append(f"- Time Horizon: {profile.get('time_horizon') or 'not provided'}")
    lines.append(f"- Primary Goal: {profile.get('primary_goal') or 'not provided'}")
    lines.append(f"- Available Capital to Deploy: {profile.get('available_capital') or 'none right now'}")

    # Holdings
    lines.append("")
    if grand_total > 0:
        lines.append(f"CURRENT HOLDINGS (total portfolio value: {_fmt_price(grand_total, _CURRENCY_SYM)}):")
    else:
        lines.append("CURRENT HOLDINGS:")

    if not rows:
        lines.append("- (no holdings configured)")
    for r in rows:
        sym    = r["symbol"]
        label  = sym.replace("-USD", "").replace("-USDT", "") if r["type"] == "crypto" else sym
        atype  = "Crypto" if r["type"] == "crypto" else "Equity"
        value  = r["value"]
        pct    = (value / grand_total * 100) if grand_total > 0 else 0
        shares = r["shares"]
        price  = r["price"]
        seg = (
            f"- {label} | {atype} | {shares:g} units | "
            f"price {_fmt_price(price, _CURRENCY_SYM) if price is not None else '—'} | "
            f"value {_fmt_price(value, _CURRENCY_SYM)} | {pct:.1f}% of portfolio"
        )
        f = r.get("fundamentals") or {}
        if r["type"] == "equity" and any(f.get(k) is not None for k in ("pe", "roe", "de", "fcf")):
            metrics = []
            if f.get("pe")  is not None: metrics.append(f"P/E {f['pe']}")
            if f.get("roe") is not None: metrics.append(f"ROE {f['roe']}%")
            if f.get("de")  is not None: metrics.append(f"D/E {f['de']}")
            if f.get("fcf") is not None: metrics.append(f"FCF {_CURRENCY_SYM}{f['fcf']}")
            seg += " | " + ", ".join(metrics)
        elif r["type"] == "crypto":
            seg += " | (equity fundamentals not applicable)"
        lines.append(seg)

    lines.append("")
    lines.append(
        "Market session: OPEN (live prices)." if market_open
        else "Market session: CLOSED (equity prices are last-close; crypto trades 24/7)."
    )

    return f"{persona}\n\n{chr(10).join(lines)}"


@router.get("/stocks/portfolio/analysis")
async def get_portfolio_analysis(force: bool = Query(False)):
    """Return the analyst persona prompt + a built PORTFOLIO DATA block for LLM injection."""
    _t0 = time.time()
    wl       = _load_watchlist()
    profile  = wl.get("profile", dict(_DEFAULT_WATCHLIST["profile"]))
    holdings = [
        h for h in (wl.get("my_stocks", []) + wl.get("my_crypto", []))
        if float(h.get("shares") or 0) != 0
    ]

    loop = asyncio.get_running_loop()

    quotes = await asyncio.gather(
        *[loop.run_in_executor(None, _fetch_ticker, h["symbol"]) for h in holdings],
        return_exceptions=True,
    )
    fundamentals = await asyncio.gather(
        *[loop.run_in_executor(None, _fetch_fundamentals, h["symbol"]) for h in holdings],
        return_exceptions=True,
    )

    rows: list = []
    grand_total = 0.0
    for h, q, f in zip(holdings, quotes, fundamentals):
        price  = q["price"] if isinstance(q, dict) and q.get("price") is not None else None
        shares = float(h.get("shares") or 0)
        value  = (price * shares) if price is not None else 0.0
        grand_total += value
        rows.append({
            "symbol":       h["symbol"].upper(),
            "type":         _ticker_type(h["symbol"]),
            "shares":       shares,
            "price":        price,
            "value":        value,
            "fundamentals": f if isinstance(f, dict) else {},
        })

    market_open = _is_us_market_open()
    context = _build_portfolio_analysis_context(profile, rows, grand_total, market_open)

    session_log.log("tool_result", {
        "endpoint":       "/stocks/portfolio/analysis",
        "status_code":    200,
        "duration_ms":    round((time.time() - _t0) * 1000),
        "result_summary": f"holdings={len(rows)}, total={round(grand_total, 2)}",
    })

    return {
        "llm_context": context,
        "profile":     profile,
        "holdings":    rows,
        "total":       round(grand_total, 2),
        "total_fmt":   _fmt_price(grand_total, _CURRENCY_SYM),
        "market_open": market_open,
    }

async def get_stocks():
    """Return live price data grouped by watchlist; backward-compat flat 'tickers' + 'llm_context' included."""
    _t0 = time.time()
    session_log.log("tool_call", {
        "endpoint": "/stocks",
        "method":   "GET",
        "params_summary": "watchlist",
    })
    watchlist = _load_watchlist()
    symbols   = _flat_tickers(watchlist)

    # Include My Stocks / My Crypto holdings so their quotes are available even
    # when a holding ticker is not part of any watchlist group.
    for key in ("my_stocks", "my_crypto"):
        for h in watchlist.get(key, []):
            sym = str(h.get("symbol", "")).strip().upper()
            if sym and sym not in symbols:
                symbols.append(sym)

    loop    = asyncio.get_running_loop()
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

    _result = {
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
    session_log.log("tool_result", {
        "endpoint":      "/stocks",
        "status_code":   200,
        "duration_ms":   round((time.time() - _t0) * 1000),
        "result_summary": f"tickers={[t['symbol'] for t in flat]}, failed={failed}",
    })
    try:
        import system_state
        system_state.record_event(
            "stocks_fetch",
            duration_s=round(time.time() - _t0, 3),
            metadata={"tickers": len(flat), "failed": len(failed), "market_open": market_open},
        )
    except Exception:
        pass
    return _result


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

    loop    = asyncio.get_running_loop()
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

    loop    = asyncio.get_running_loop()
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
    loop         = asyncio.get_running_loop()
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
