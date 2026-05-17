# S.T.A.R.L.I.N.G. Toolkit

Voice-activated tool modules built into S.T.A.R.L.I.N.G. Each tool is a self-contained
intercept in the voice dispatch chain — triggered before the LLM with no impact on the
core chat pipeline.

See [`TRIGGER_PHRASES.md`](./TRIGGER_PHRASES.md) for the full voice command reference.

---

## Tools

| # | Tool | Guide | Backend | Status |
|---|---|---|---|---|
| 1 | Time & Date | [`markdown/complete/TIME.md`](../markdown/complete/TIME.md) | None | ✅ Done |
| 2 | Timers | [`markdown/complete/TIMER.md`](../markdown/complete/TIMER.md) | None | ✅ Done |
| 3 | Weather | [`markdown/complete/WEATHER.md`](../markdown/complete/WEATHER.md) | Open-Meteo (free, no key) | ✅ Done |
| 4 | News Briefing | [`markdown/complete/NEWS.md`](../markdown/complete/NEWS.md) | RSS / feedparser (free) | ✅ Done |
| 5 | Stocks & Crypto | [`markdown/STOCKS.md`](../markdown/STOCKS.md) | yfinance (unofficial) | ✅ Done |
| 6 | Wake Word & Interrupt | [`markdown/WAKE_WORD.md`](../markdown/WAKE_WORD.md) | None | 🔲 Planned |
| 7 | In-UI Browser Panel | [`markdown/WEBCALL.md`](../markdown/WEBCALL.md) | None | ✅ Done |
| 8 | Ideas Tracker | [`markdown/IDEAS_TRACKER.md`](../markdown/IDEAS_TRACKER.md) | Local JSON file | 🔲 Planned |
| 9 | Voice Journal | [`markdown/JOURNAL.md`](../markdown/JOURNAL.md) | Local JSON files | 🔲 Planned |
| 10 | Wikipedia RAG | [`markdown/WIKIPEDIA.md`](../markdown/WIKIPEDIA.md) | FAISS + embeddings | 🔲 Planned |
| 11 | Google Calendar | [`markdown/CALENDAR.md`](../markdown/CALENDAR.md) | Google Calendar API (OAuth2) | 🔲 Planned |
| 12 | Gmail | [`markdown/GMAIL.md`](../markdown/GMAIL.md) | Gmail API (OAuth2) | 🔲 Planned |

Tools dispatch in priority order — the first matching tool wins; unmatched input falls
through to the LLM. See [`TRIGGER_PHRASES.md`](./TRIGGER_PHRASES.md) for the full ordering
reference.

---

## Dispatch Priority

| Priority | Tool | Notes |
|----------|------|-------|
| 1 | Dossier — exit | Checked before everything else |
| 2 | Dossier — open | |
| 3 | Timer | Checked before Time to avoid "timer" matching time patterns |
| 4 | Date | Checked before Time — date phrases are more specific |
| 5 | Time | |
| 6 | Weather | |
| 7 | Market / Stocks / Crypto | More specific domain vocabulary, checked before News |
| 8 | News | |
| 9 | Browser / Web Panel | Wikipedia lookups, open URL, or DuckDuckGo search |
| 10 | LLM fallback | Anything unmatched |

---

## Dossier / Presentation Mode

Opens a full-screen personnel dossier panel with a subject portrait, structured profile,
and an automatic LLM-spoken briefing. Subject data is loaded from
`assets/dossier_descriptions/` and `assets/dossier_images/`.

**Open triggers:**  
`"pull up the dossier on Daniel Simpson"` · `"show dossier"` · `"open dossier for Quinn"` · `"display dossier about Mark Stent"`

**Close triggers:**  
`"close dossier"` · `"end briefing"` · `"go back"` · `"back to chat"` · `"never mind"`

![S.T.A.R.L.I.N.G. Presentation Mode](../assets/images/presentation_mode_example.png)

Implementation guide: [`markdown/complete/RAG_IMPLEMENTATION.md`](../markdown/complete/RAG_IMPLEMENTATION.md)

---

## Time & Date

Returns the current time or today's date spoken aloud. Zero-latency — no backend call,
no LLM involved.

**Time triggers:**  
`"what time is it"` · `"what's the time"` · `"tell me the time"` · `"current time"` · `"time please"`

**Date triggers:**  
`"what's today's date"` · `"what day is it"` · `"what day of the week is it"` · `"today's date"`

![S.T.A.R.L.I.N.G. Clock Panel](../assets/images/clock_example.png)

Implementation guide: [`markdown/complete/TIME.md`](../markdown/complete/TIME.md)

---

## Timers

Sets or cancels multiple named countdown timers entirely in-browser. Supports fractional
durations, optional labels (prefix or `called` / `named` suffix), and a Web Audio API
chime on completion.

**Set triggers:**  
`"set a timer for five minutes"` · `"set a pasta timer for 12 minutes"` · `"30 second timer"` · `"set a timer for 1 hour"` · `"set a timer for 5 minutes called laundry"`

**Cancel triggers:**  
`"cancel timer"` · `"cancel the pasta timer"` · `"stop timer"` · `"clear all timers"`

**Active timer:**

![S.T.A.R.L.I.N.G. Timer Panel — active](../assets/images/timer_example1.png)

**Timer complete:**

![S.T.A.R.L.I.N.G. Timer Panel — complete](../assets/images/timer_example2.png)

Implementation guide: [`markdown/complete/TIMER.md`](../markdown/complete/TIMER.md)

---

## Weather

Opens a 7-day forecast panel sourced from Open-Meteo (free, no API key). Supports
named-location queries resolved via Nominatim geocoding with geodesic proximity
disambiguation. Responses are disk-cached with a 1-hour TTL and up to 168 historical
snapshots per location. The LLM delivers a spoken conditions summary.

**Default location triggers:**  
`"what's the weather"` · `"weather forecast"` · `"show the weather"` · `"how's it looking outside"` · `"what's it like outside"`

**Named location triggers:**  
`"weather in Boston"` · `"what's the weather in London"` · `"forecast for Tokyo"` · `"show me the weather for Paris"`

![S.T.A.R.L.I.N.G. Weather Panel](../assets/images/weather_example.png)

Configuration (`.env`): `WEATHER_LOCATION`, `WEATHER_UNITS`, `WEATHER_CACHE_FILE`, `WEATHER_DEFAULT_LABEL`

Implementation guide: [`markdown/complete/WEATHER.md`](../markdown/complete/WEATHER.md)

---

## News Briefing

Opens a live headlines panel sourced from configurable RSS feeds. LLM synthesis runs in
the background and patches in story cards when ready. Supports category filtering — append
a category keyword anywhere in the phrase.

**General triggers:**  
`"what's the news"` · `"morning briefing"` · `"top headlines"` · `"catch me up"` · `"daily brief"` · `"breaking news"`

**Category triggers:**

| Keyword | Feed |
|---------|------|
| `tech` · `technology` | Technology |
| `financial` · `finance` · `business` · `economy` | Business |
| `american` · `us` · `usa` | US |
| `science` · `scientific` | Science |
| `health` · `medical` | Health |
| `sports` · `sport` | Sports |
| `entertainment` · `celebrity` | Entertainment |
| `world` · `global` · `international` | World (default) |

**Example:** `"tech news"` · `"financial news"` · `"sports headlines"` · `"world news"`

> **Note:** Phrases like `"business briefing"` or `"financial briefing"` route to the
> **Market** tool, not News. Use `"business news"` or `"financial news"` to get news stories.

![S.T.A.R.L.I.N.G. News Panel](../assets/images/news_example.png)

Configuration (`.env`): `NEWS_FEEDS`, `NEWS_MAX_ITEMS`, `NEWS_CACHE_SECONDS`

Implementation guide: [`markdown/complete/NEWS.md`](../markdown/complete/NEWS.md)

---

## Stocks & Crypto

Opens a live market data panel powered by Yahoo Finance (`yfinance`). Displays price,
% change (colour-coded), 52-week range, and market cap per ticker. Shows a market-hours
badge (OPEN / CLOSED) and filter tabs for Stocks / Crypto / Indices. 5-minute cache with
manual refresh. The LLM delivers a spoken briefing highlighting notable movers.

**Stocks / equities triggers:**  
`"market briefing"` · `"show stocks"` · `"how are the markets"` · `"portfolio briefing"` · `"NVIDIA"` · `"check MSFT"` · `"Apple stock"`

**Crypto triggers:**  
`"show crypto"` · `"bitcoin price"` · `"ethereum price"` · `"crypto update"` · `"BTC price"`

**General triggers:**  
`"financial update"` · `"what's the market"` · `"brief me on financials"`

![S.T.A.R.L.I.N.G. Stocks & Crypto Panel](../assets/images/stock_example.png)

Configuration (`.env`): `STOCKS_WATCHLIST`, `CRYPTO_WATCHLIST`, `STOCKS_CACHE_SECONDS`, `STOCKS_CURRENCY_SYMBOL`

Implementation guide: [`markdown/STOCKS.md`](../markdown/STOCKS.md)

---

## In-UI Browser Panel

Opens an embedded browser panel (iframe) inside the UI. Navigates to the requested URL,
extracts page text server-side via the backend, and injects it as LLM context so you can
ask questions or request summaries about any open page. Supports Wikipedia lookups,
arbitrary URLs, and DuckDuckGo searches.

**Wikipedia triggers:**  
`"look up [topic] on Wikipedia"` · `"search Wikipedia for [topic]"` · `"wikipedia about [topic]"` · `"wikipedia on [topic]"`

**Open URL triggers:**  
`"open browser https://example.com"` · `"open browser example.com"`

**Search triggers:**  
`"browser search for [query]"` · `"browser search [query]"`

**Close triggers:**  
`"close browser"` · `"exit browser"` · `"dismiss browser"` · `"hide browser"`

![S.T.A.R.L.I.N.G. Browser Panel](../assets/images/web_example.png)

Implementation guide: [`markdown/WEBCALL.md`](../markdown/WEBCALL.md)

---

## Planned Tools

| Tool | Guide | Notes |
|------|-------|-------|
| Wake Word & Interrupt | [`WAKE_WORD.md`](../markdown/WAKE_WORD.md) | Passive listener; say "Hey Starling" to activate without pressing mic |
| Ideas Tracker | [`IDEAS_TRACKER.md`](../markdown/IDEAS_TRACKER.md) | Voice capture and full-text search of ideas stored to local JSON |
| Voice Journal | [`JOURNAL.md`](../markdown/JOURNAL.md) | Multi-turn voice journaling with search and playback |
| Wikipedia RAG | [`WIKIPEDIA.md`](../markdown/WIKIPEDIA.md) | Fetch, chunk, and query Wikipedia articles via FAISS + embeddings |
| Google Calendar | [`CALENDAR.md`](../markdown/CALENDAR.md) | Read today's / week's events via Google Calendar OAuth2 |
| Gmail | [`GMAIL.md`](../markdown/GMAIL.md) | Inbox summary, message read-out, and trash via Gmail API OAuth2 |
