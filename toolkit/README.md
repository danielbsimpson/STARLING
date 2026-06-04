# S.T.A.R.L.I.N.G. Toolkit

Voice-activated tool modules built into S.T.A.R.L.I.N.G. Each tool is a self-contained
intercept in the voice dispatch chain — triggered before the LLM with no impact on the
core chat pipeline.

See [`TRIGGER_PHRASES.md`](./TRIGGER_PHRASES.md) for the full voice command reference.

---

## Tools

| # | Tool | Guide | Backend | Status |
|---|---|---|---|---|
| 1 | Time & Date | `TIME.md` | None | ✅ Done |
| 2 | Timers | `TIMER.md` | None | ✅ Done |
| 3 | Weather | `WEATHER.md` | Open-Meteo (free, no key) | ✅ Done |
| 4 | Drive Time / Commute | `DIRECTIONS.md` | OpenRouteService (httpx, self-hostable / free key) | ✅ Done |
| 5 | News Briefing | `NEWS.md` | RSS / feedparser (free) | ✅ Done |
| 6 | Research Papers | `PAPERS.md` | arXiv + Semantic Scholar (httpx/feedparser, no key) | ✅ Done |
| 7 | Stocks & Crypto | `STOCKS.md` | yfinance (unofficial) | ✅ Done |
| 8 | Wake Word & Interrupt | `feature-wake-word-1.md` | None | 🔲 Planned |
| 9 | In-UI Browser Panel | `WEBCALL.md` | None | ✅ Done |
| 10 | Ideas Vault | `IDEAS_TRACKER.md` | Local JSON file | ✅ Done |
| 11 | Voice Journal | `JOURNAL.md` | Local JSON files | ✅ Done |
| 12 | Wikipedia RAG | `WIKIPEDIA.md` | ChromaDB + fastembed | ✅ Done |
| 13 | Reddit Social Feed | `feature-reddit-social-1.md` | Reddit JSON API (no auth) | ✅ Done |
| 14 | YouTube Feed | `feature-youtube-feed-1.md` | YouTube Atom RSS (no key) | ✅ Done |
| 15 | Toolkit Menu | `feature-toolkit-menu-1.md` | None (frontend only) | ✅ Done |
| 16 | iCloud Calendar | `CALENDAR.md` | CalDAV (stdlib only, Apple ID) | ✅ Done |
| 17 | Apple Mail Inbox | `feature-apple-mail-inbox-1.md` | IMAP (stdlib only, Apple ID) | ✅ Done |
| 18 | System Status | `feature-system-awareness-1.md` | Local runtime introspection (`/system/status`) | ✅ Done |
| 19 | Soul Panel / Soul File | `feature-starling-soul-personality-1.md` | Local soul store (`backend/memory/soul/`) | ✅ Done |

Tools dispatch in priority order — the first matching tool wins; unmatched input falls
through to the LLM. See [`TRIGGER_PHRASES.md`](./TRIGGER_PHRASES.md) for the full ordering
reference.

---

## Dispatch Priority

| Priority | Tool | Notes |
|----------|------|-------|
| 1 | Toolkit confirm intercept | Active only while a toolkit confirm is pending; must be first |
| 2 | Fuzzy confirm intercept | Active only while fuzzy "did you mean" confirmation is pending |
| 3 | Browser — close | Only when browser panel is open |
| 4 | Wikipedia RAG — exit/in-mode | While wiki panel is active, all input routes to wiki chat except exit phrases |
| 5 | Journal — in-mode routing | Only when journal dictation / interview is active |
| 6 | Ideas — in-mode routing | Only when ideas capture mode is active |
| 7 | Research Papers — close | Only when papers panel is open |
| 8 | News — close | Only when news panel is open |
| 9 | Weather — close | Only when weather panel is open |
| 10 | Directions — close | Only when directions panel is open |
| 11 | YouTube — close | |
| 12 | Reddit — close | |
| 13 | Mail inbox — close | Only when mail panel is open |
| 14 | Dossier — exit | |
| 15 | Soul Panel — open | Voice trigger for viewing/editing `SOUL.md` |
| 16 | Prompt Registry editor — open | Opens the prompt editor sub-view inside the menu panel |
| 17 | Toolkit Menu — open | Checked before dossier open to avoid conflicts |
| 18 | Dossier — open | |
| 19 | Wikipedia RAG — open | Requires **"local"** or **"offline"** keyword |
| 20 | Journal — start | |
| 21 | Journal — read / search | |
| 22 | Timer | Checked before Time to avoid "timer" matching time patterns |
| 23 | Date | Checked before Time — date phrases are more specific |
| 24 | Time | |
| 25 | System Status | Voice summary of runtime health/telemetry |
| 26 | Ideas Vault — capture | Both "idea/ideas" **and** "vault" must appear |
| 27 | Ideas Vault — read / manage | Both "idea/ideas" **and** "vault" must appear |
| 28 | Weather | |
| 29 | Directions | Specific navigation/commute vocabulary |
| 30 | Calendar | iCloud CalDAV; checked before Mail |
| 31 | Mail inbox | IMAP fetch from Apple Mail |
| 32 | Market / Stocks / Crypto | Checked before News — more specific domain vocabulary |
| 33 | YouTube feed | Requires **"youtube feed"** — checked before Reddit and News |
| 34 | Reddit social feed | Requires **"reddit social"** — checked before News |
| 35 | Research Papers | Checked before News due to scholarly vocabulary |
| 36 | News | |
| 37 | Browser — open | Requires **"browser"** keyword; Wikipedia also requires **"browser"** |
| 38 | LLM fallback | Anything unmatched |

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

Implementation guide: `RAG_IMPLEMENTATION.md`

---

## Time & Date

Returns the current time or today's date spoken aloud. Zero-latency — no backend call,
no LLM involved.

**Time triggers:**  
`"what time is it"` · `"what's the time"` · `"tell me the time"` · `"current time"` · `"time please"`

**Date triggers:**  
`"what's today's date"` · `"what day is it"` · `"what day of the week is it"` · `"today's date"`

![S.T.A.R.L.I.N.G. Clock Panel](../assets/images/clock_example.png)

Implementation guide: `TIME.md`

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

Implementation guide: `TIMER.md`

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

Implementation guide: `WEATHER.md`

---

## Drive Time / Commute

Opens the directions panel and fetches route duration + distance using OpenRouteService,
with optional fallback support for OSRM. Supports driving (default), walking, and biking
profiles based on spoken intent. The map view shows origin/destination, route geometry,
and estimated slowdown zones derived from segment-speed heuristics.

**Open triggers:**
`"how long to drive to Logan Airport"` · `"what's my commute to the office"` · `"directions to South Station"` · `"walking time to the park"` · `"bike time to Cambridge"`

**Close triggers:**
`"close directions"` · `"close commute"` · `"close drive time"`

![S.T.A.R.L.I.N.G. Directions Panel](../assets/images/commute_example.png)

Configuration (`.env`): `DIRECTIONS_HOME`, `DIRECTIONS_HTTP_TIMEOUT_S`, `DIRECTIONS_CACHE_SECONDS`, `DIRECTIONS_DEFAULT_PROFILE`, `DIRECTIONS_OSRM_FALLBACK`

Implementation guide: `DIRECTIONS.md`

---

## Research Papers

Opens the research papers panel and delivers a spoken briefing grounded in recent
results from arXiv + Semantic Scholar (no API key). The tool extracts a spoken topic,
applies a recency window (`today`, `week`, `month`, `year`, or `any`), merges and
de-duplicates results, and provides a concise spoken summary.

**Open triggers:**
`"any new papers on graph neural networks this week"` · `"find recent research about retrieval augmented generation"` · `"what's new in reinforcement learning research"` · `"show me arxiv papers on diffusion models"`

**Close triggers:**
`"close papers"` · `"close research papers"`

Configuration (`.env`): `PAPERS_DEFAULT_SINCE`, `PAPERS_CACHE_SECONDS`, `PAPERS_HTTP_TIMEOUT_S`, `PAPERS_LLM_LIMIT`, `PAPERS_MAX_RESULTS`, `PAPERS_SUMMARY_CHARS`

Implementation guide: `PAPERS.md`

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

Implementation guide: `NEWS.md`

---

## Ideas Vault

Captures, lists, searches, and manages ideas stored to a local JSON file. All patterns
require **both** `idea`/`ideas` **and** `vault` to appear in the phrase.

**Capture triggers:**  
`"store an idea in the vault"` · `"add an idea to the vault"` · `"capture for the ideas vault"` · `"save to the ideas vault"`

**List triggers:**  
`"open ideas vault"` · `"show the ideas vault"` · `"what's in the ideas vault"`

**Search triggers:**  
`"search the ideas vault for [topic]"` · `"find [topic] in the ideas vault"`

**Discard / clear triggers:**  
`"discard the last idea from the vault"` · `"clear the ideas vault"` · `"delete all ideas from the vault"`

Implementation guide: `IDEAS_TRACKER.md`

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

Implementation guide: `STOCKS.md`

---

## In-UI Browser Panel

Opens an embedded browser panel (iframe) inside the UI. Navigates to the requested URL,
extracts page text server-side via the backend, and injects it as LLM context so you can
ask questions or request summaries about any open page. Supports Wikipedia lookups,
arbitrary URLs, and DuckDuckGo searches.

**Wikipedia triggers (browser-qualified):**  
`"browser wikipedia [topic]"` · `"browser window wikipedia [topic]"` · `"search [topic] on Wikipedia in browser"` · `"look up [topic] on Wikipedia in browser"`

**Open URL triggers:**  
`"open browser https://example.com"` · `"open browser example.com"`

**Search triggers:**  
`"browser search for [query]"` · `"browser search [query]"`

**Close triggers:**  
`"close browser"` · `"exit browser"` · `"dismiss browser"` · `"hide browser"`

![S.T.A.R.L.I.N.G. Browser Panel](../assets/images/web_example.png)

Implementation guide: `WEBCALL.md`

---

## Voice Journal

Opens a dictation panel for multi-segment voice journaling. Each mic press appends a
segment; on submit the LLM silently generates a summary and tags. Supports a guided
interviewer mode and read-back / keyword search of saved entries.

**Start triggers:** `start journal entry` · `new journal entry` · `journal note` · `begin a journal entry` · `interviewer mode`

**Read triggers:** `show journal` · `open journal entries` · `journal history` · `read my last journal entry` · `today's journal entries`

**Search triggers:** `search journal for [topic]` · `what did I write about [topic]`

![S.T.A.R.L.I.N.G. Journal Panel](../assets/images/journal_example1.png)

Implementation guide: `JOURNAL.md`

---

## Wikipedia RAG (Local / Offline)

Searches the locally-ingested Simple English Wikipedia dump (ChromaDB + nomic-embed-text)
and opens a guardrailed Q&A session in the wiki panel. **Requires "local" or "offline" in
the phrase** to avoid conflict with the browser-panel Wikipedia lookup (which requires
"browser").

**Open triggers:** `local wikipedia search [query]` · `local wiki article on [topic]` · `search local wikipedia for [query]` · `offline wikipedia [topic]` · `find [topic] on local wiki`

**Exit triggers:** `exit wikipedia` · `close wiki` · `back to chat` · `go back` · `never mind`

Configuration: run `python scripts/ingest_wikipedia.py` once to build the index.  
Implementation guide: `WIKIPEDIA.md`

---

## Toolkit Menu

A voice- and button-triggered overlay panel that lists every active Starling tool with its
name, description, and representative activation phrases. Selecting a tool hands its name
and description to the LLM for a natural spoken briefing, then asks whether to activate it.
Yes / No confirmation available by voice or click. Confirm state auto-cancels after 20 s.

**Open triggers:**  
`"show tools"` · `"open toolkit"` · `"tool menu"` · `"what tools do you have"` · `"show me your tools"`

![S.T.A.R.L.I.N.G. Toolkit Menu](../assets/images/menu_example.png)

Implementation guide: `feature-toolkit-menu-1.md`

---

## Reddit Social Feed

Opens a live Reddit feed panel sourced from the public Reddit JSON API — no API key or
login required. Fetches top/hot posts from a configurable subreddit list with per-subreddit
filter tabs. LLM synthesis runs in the background; Starling delivers a spoken briefing when
ready. A settings panel lets you add or remove subreddits at runtime.

**Open triggers (strict match only):**  
`"open reddit social"` · `"view reddit social"`

**Close triggers:**  
`"close reddit"` · `"close social"`

![S.T.A.R.L.I.N.G. Reddit Social Feed](../assets/images/reddit_example.png)

Configuration (`.env`): `REDDIT_SUBREDDITS`, `REDDIT_LIMIT_PER_SUB`, `REDDIT_CACHE_SECONDS`, `REDDIT_SORT`

Implementation guide: Internal Reddit Social guide

---

## YouTube Feed

Opens a YouTube channel feed panel sourced from public Atom/RSS — no API key required.
Displays recent videos as a tile grid with type filters (All / Long / Shorts), per-channel
filters, and sort options. An in-panel modal lets you open any video for immediate playback.
LLM synthesis runs in the background; Starling delivers a spoken briefing when ready.
A settings panel lets you add or remove channels at runtime.

**Open triggers (strict match only):**  
`"open youtube feed"` · `"view youtube feed"`

**Close triggers:**  
`"close youtube"` · `"close feed"`

![S.T.A.R.L.I.N.G. YouTube Feed](../assets/images/youtube_example1.png)

![S.T.A.R.L.I.N.G. YouTube Feed Video Modal](../assets/images/youtube_example2.png)

Configuration (`.env`): `YOUTUBE_CHANNELS`, `YOUTUBE_CACHE_SECONDS`, `YOUTUBE_SYNTHESIS_ENABLED`

Implementation guide: Internal YouTube Feed guide

---

## iCloud Calendar

Opens a CalDAV calendar panel showing today's and the coming week's events fetched from
iCloud. No third-party packages required — uses Python stdlib (`xml.etree`, `http.client`).
Requires an Apple ID and App-Specific Password configured in the toolkit login form.
Calendar data is disk-cached with a 1-hour TTL.

**Open triggers:**  
`"show my calendar"` · `"check my calendar"` · `"what's on my schedule"` · `"any meetings today"` · `"open calendar"`

**Refresh triggers:**  
`"refresh my calendar"` · `"sync my calendar"` · `"update my calendar"`

![S.T.A.R.L.I.N.G. Calendar Panel](../assets/images/ical_example.png)

Configuration (`.env`): `CALDAV_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD`, `CALENDAR_CACHE_SECONDS`

Implementation guide: `CALENDAR.md`

---

## Apple Mail Inbox

Opens an IMAP inbox panel showing the most recent unread messages from Apple Mail.
Fetches only FROM, SUBJECT, and DATE headers — no body content is ever read.
No third-party packages required — uses Python stdlib (`imaplib`, `email`, `ssl`).
Requires an Apple ID and App-Specific Password configured in the toolkit login form.
Results are in-memory cached with a 5-minute TTL.

**Open triggers:**  
`"check my email"` · `"any new emails"` · `"what's in my inbox"` · `"unread messages"` · `"check mail"`

**Close triggers:**  
`"close mail"` · `"close email"` · `"exit inbox"` · `"hide mail"`

![S.T.A.R.L.I.N.G. Mail Panel](../assets/images/imail_example.png)

Configuration (`.env`): `IMAP_HOST`, `IMAP_PORT`, `IMAP_USERNAME`, `IMAP_PASSWORD`, `MAIL_MAX_UNREAD`, `MAIL_CACHE_SECONDS`

Implementation guide: `feature-apple-mail-inbox-1.md`

---

## System Status (System Awareness)

Speaks a short runtime-health summary backed by `GET /system/status` and can also open
the full SYSTEM STATUS panel from the menu. Reports active backends, tool inventory,
boot duration, and live GPU/runtime telemetry.

**Voice triggers:**
`"system status"` · `"what's your status"` · `"how are you running"` · `"are you healthy"` · `"self diagnostic"`

![S.T.A.R.L.I.N.G. System Status Panel](../assets/images/systemStatus_example.png)

Implementation guide: `feature-system-awareness-1.md`

---

## Starling Soul

The soul system maintains a persistent `SOUL.md` that is injected into LLM system prompts
and can be reviewed/edited in the Soul Panel. During shutdown dream-state processing,
Starling can evolve the soul file and archive previous versions.

**Open triggers:**
`"open soul"` · `"show soul"` · `"view soul file"` · `"edit soul"`

Implementation guide: `feature-starling-soul-personality-1.md`

---

## Planned Tools

| Tool | Guide | Notes |
|------|-------|-------|
| Wake Word & Interrupt | `feature-wake-word-1.md` | Passive listener; say "Hey Starling" to activate without pressing mic |


