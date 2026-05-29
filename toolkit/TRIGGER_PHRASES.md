# Starling — Trigger Phrase Reference

All voice (and text) input passes through a **priority-ordered dispatch chain**.
The first matching tool wins; unmatched input falls through to the LLM.

---

## Dispatch Priority Order

| Priority | Tool | Notes |
|----------|------|-------|
| 1 | Toolkit confirm intercept | Active only while a toolkit confirm is pending; must be first |
| 2 | Browser — close | Only when browser panel is open |
| 3 | Wikipedia RAG — exit | Only when wiki panel is active |
| 4 | Journal — in-mode routing | Only when journal dictation / interview is active |
| 5 | Ideas — in-mode routing | Only when ideas capture mode is active |
| 6 | Weather — close | Only when weather panel is open |
| 7 | YouTube — close | |
| 8 | Reddit — close | |
| 9 | Mail inbox — close | Only when mail panel is open |
| 10 | Dossier — exit | |
| 11 | Toolkit Menu — open | Checked before dossier open to avoid conflicts |
| 12 | Dossier — open | |
| 13 | Wikipedia RAG — open | Requires **"local"** or **"offline"** keyword |
| 14 | Journal — start | |
| 15 | Journal — read / search | |
| 16 | Timer | Checked before Time to avoid "timer" matching time patterns |
| 17 | Date | Checked before Time — date phrases are more specific |
| 18 | Time | |
| 19 | Ideas Vault — capture | Both "idea/ideas" **and** "vault" must appear |
| 20 | Ideas Vault — read / manage | Both "idea/ideas" **and** "vault" must appear |
| 21 | Weather | |
| 22 | Calendar | iCloud CalDAV; checked before Mail |
| 23 | Mail inbox | IMAP fetch from Apple Mail |
| 24 | Market / Stocks / Crypto | Checked before News — more specific domain vocabulary |
| 25 | YouTube feed | Requires **"youtube feed"** — checked before Reddit and News |
| 26 | Reddit social feed | Requires **"reddit social"** — checked before News |
| 27 | News | |
| 28 | Browser — open | Requires **"browser"** keyword; Wikipedia lookup also requires **"browser"** |
| 29 | Prompt Registry editor | Opens the prompt editor sub-view inside the menu panel |
| 30 | LLM fallback | Anything unmatched |

---

## 1 · Dossier (Presentation Mode)

Opens a full-screen personnel dossier panel populated from RAG markdown files.
Optionally accepts a subject name after the keyword phrase.

### Open

Trigger verb: `open` · `show` · `pull up` · `display` · `launch` · `activate`
Required keyword: `dossier`
Optional subject: `on` / `for` / `about` / `regarding` / `of` + name

| Example phrase | Subject resolved |
|----------------|-----------------|
| `open dossier` | None (generic open) |
| `show dossier on Daniel Simpson` | Daniel Simpson |
| `pull up the dossier for Quinn` | Quinn |
| `display dossier about Mark Stent` | Mark Stent |
| `launch dossier regarding Danielle Smith` | Danielle Smith |

### Close / Exit

| Example phrase |
|----------------|
| `close dossier` |
| `exit dossier` |
| `hide dossier` |
| `dismiss dossier` |
| `end briefing` · `end presentation` |
| `stop briefing` |
| `go back` |
| `back to chat` · `back to main` |
| `resume chat` · `return to chat` |
| `never mind` · `nevermind` · `cancel that` |

---

## 2 · Toolkit Menu

Opens a browsable overlay panel listing every active Starling tool with its name,
description, and representative activation phrases. Selecting a tool triggers an LLM
spoken briefing about it; a Yes / No confirmation (voice or click) then opens the tool
directly or returns to the menu. The confirm state auto-cancels after 20 seconds.

### Open

| Example phrase |
|----------------|
| `show tools` · `open tools` · `display tools` · `list tools` |
| `show toolkit` · `open toolkit` · `display toolkit` |
| `show the menu` · `open the menu` · `show tool menu` |
| `what tools do you have` · `what tools` |
| `show me your tools` · `show me all tools` |
| `tool menu` · `tool list` |
| `system settings` · `system menu` |

### Confirm / Cancel (active only while toolkit confirm is pending)

| Example phrase | Action |
|----------------|--------|
| `yes` · `yeah` · `yep` · `sure` · `do it` · `activate` · `open it` · `confirm` | Activate selected tool |
| `no` · `nope` · `cancel` · `never mind` · `back` · `go back` · `close` | Dismiss and return to list |

> **Note:** The confirm state auto-cancels after 20 seconds with no follow-up.

---

## 3 · Timer

Sets or cancels a countdown timer with an optional label.

### Set a timer

| Example phrase | Notes |
|----------------|-------|
| `set a timer for five minutes` | |
| `set a ten minute timer` | |
| `timer for 2 minutes 30 seconds` | |
| `start a 90 second timer` | |
| `set an hour timer` | |
| `thirty second timer` | Bare duration + "timer" |
| `set a pasta timer for 12 minutes` | Label extracted: "pasta" |
| `set a timer for one and a half minutes` | Fractional duration |
| `set a timer for 5 minutes called pasta` | Label via "called" keyword |

**Supported duration words:** `one` through `twelve`, `fifteen`, `twenty`, `thirty`,
`forty`, `fifty`, `sixty`, `ninety`, `hundred`, `half`, `a half`, or any digit.

**Label extraction (two methods):**
- Suffix: `set a timer for 5 minutes called <label>` or `named <label>`
- Prefix: `set a <label> timer for …` (e.g., "pasta", "egg", "laundry")

### Cancel a timer

| Example phrase | Notes |
|----------------|-------|
| `cancel timer` | Cancels all timers |
| `stop timer` | |
| `clear timer` · `dismiss timer` · `delete timer` | |
| `cancel all timers` | |
| `cancel the pasta timer` | Cancels by label |

---

## 4 · Date

Returns today's date spoken aloud. Checked before Time.

| Example phrase |
|----------------|
| `what's today's date` |
| `what is the date` |
| `what day is it` |
| `what day of the week is it` |
| `what date is it today` |
| `today's date` |
| `what day is it today` |

---

## 5 · Time

Returns the current local time spoken aloud.

| Example phrase |
|----------------|
| `what's the time` |
| `what time is it` |
| `tell me the time` |
| `do you know the time` |
| `current time` |
| `can you tell me the time` |
| `time please` · `time now` |
| `what time is it right now` |
| `how late is it` |

---

## 6 · Voice Journal

Opens a multi-segment dictation panel. Each mic press adds a segment; the LLM
silently generates a summary and tags on submit. Supports standard dictation,
guided interviewer Q&A mode, read-back, and keyword search.

### Start a journal entry

| Example phrase |
|----------------|
| `start journal entry` |
| `new journal entry` |
| `begin a journal entry` |
| `open journal entry` |
| `create a journal entry` |
| `journal entry` |
| `journal note` |
| `start a new entry` |
| `interviewer mode` · `interview mode` |

### Read / list entries

| Example phrase | Action |
|----------------|--------|
| `show journal` | List recent entries |
| `open journal entries` | List recent entries |
| `read my journal` | List recent entries |
| `journal history` | List recent entries |
| `journal entries` | List recent entries |
| `today's journal entries` | Today only |
| `what did I write today` | Today only |
| `read my last journal entry` | Latest entry |
| `show my recent journal` | Latest entries |

### Search

| Example phrase | Query resolved |
|----------------|---------------|
| `search journal for anxiety` | anxiety |
| `find in journal for project ideas` | project ideas |
| `what did I write about travel` | travel |
| `what did I say about my goals` | my goals |

### In-dictation commands (active only while journalMode is true)

| Example phrase | Action |
|----------------|--------|
| `submit` · `done` · `finished` | Submit entry for LLM review |
| `save entry` · `complete` | Submit entry |
| `end entry` · `that's all` | Submit entry |

---

## 7 · Wikipedia RAG (Local / Offline)

Searches the locally-ingested Simple English Wikipedia dump (ChromaDB) and opens
a guardrailed Q&A session in the wiki panel.

**Requires the word "local" or "offline" in the phrase** — this distinguishes it
from the browser-panel Wikipedia lookup, which requires "browser" instead.

### Open triggers

| Example phrase | Query resolved |
|----------------|---------------|
| `local wikipedia search quantum physics` | quantum physics |
| `local wiki article on the French Revolution` | the French Revolution |
| `local wiki quantum physics` | quantum physics |
| `search local wikipedia for black holes` | black holes |
| `search local wiki for Marie Curie` | Marie Curie |
| `look up photosynthesis on local wikipedia` | photosynthesis |
| `find Alan Turing on local wiki` | Alan Turing |
| `offline wikipedia Marie Curie` | Marie Curie |
| `offline wiki search for the Roman Empire` | the Roman Empire |
| `search offline wikipedia for DNA` | DNA |

### Exit triggers (active only while wiki panel is open)

| Example phrase |
|----------------|
| `exit wikipedia` · `close wikipedia` |
| `exit wiki` · `close wiki` |
| `leave article` · `stop wikipedia` |
| `end wikipedia mode` |
| `back to chat` · `back to main` |
| `go back` |
| `never mind` · `nevermind` · `cancel that` |
| `close the panel` · `close this article` |

---

## 8 · Ideas Vault

Captures, lists, searches, and manages ideas stored to a local JSON file.
**Both `idea`/`ideas` and `vault` must appear in the phrase** — this two-word combination
is highly specific and extremely unlikely to appear in normal conversation or in phrases
that target other tools (e.g. "search Wikipedia for bank vaults" will not trigger).

### Capture — enter single-press capture mode

Speak a capture phrase → panel enters "WAITING FOR INPUT" state → press mic and speak the
idea → LLM extracts a title and tags, then saves to the vault.

| Example phrase |
|----------------|
| `open ideas vault` |
| `store an idea in the vault` |
| `store idea into the vault` |
| `save to the ideas vault` |
| `add an idea to the vault` |
| `capture for the ideas vault` |
| `capture this idea for the vault` |
| `log an idea to the vault` |
| `note an idea in the vault` |

**Required:** both `idea` or `ideas` **and** `vault` must appear in the phrase.  
**Trigger verb:** `store` · `save` · `add` · `log` · `capture` · `record` · `note`

> **Note:** `open ideas vault` alone routes to **list** (see below), not capture mode.
> Use a verb like `store` or `capture` to enter capture mode.

### List / Open

| Example phrase |
|----------------|
| `open ideas vault` |
| `show ideas vault` · `show the ideas vault` |
| `list ideas vault` · `list the ideas vault` |
| `display ideas vault` · `view ideas vault` |
| `what's in the ideas vault` · `what is in the ideas vault` |
| `ideas vault` _(bare mention)_ |

### Search

The query is extracted from the phrase automatically.

| Example phrase | Query resolved |
|----------------|---------------|
| `search the vault for machine learning` | machine learning |
| `search the ideas vault for renewable energy` | renewable energy |
| `find machine learning in the vault` | machine learning |
| `look for project ideas in the vault` | project ideas |

### Discard last

| Example phrase |
|----------------|
| `discard the last idea from the vault` |
| `delete the last idea from the vault` |
| `remove the latest idea from the vault` |

### Clear all

| Example phrase |
|----------------|
| `clear the ideas vault` |
| `empty the ideas vault` |
| `wipe the ideas vault` |
| `delete all ideas from the vault` |
| `remove all ideas from the vault` |

---

## 9 · Weather

Opens the weather panel for the current location or a named city.
Optional location is extracted after `in` / `for` / `at` following `weather` or `forecast`.

| Example phrase | Location |
|----------------|----------|
| `check the weather` | Default (device location) |
| `show the weather` | Default |
| `what's the weather` | Default |
| `get the weather` | Default |
| `tell me the weather` | Default |
| `weather forecast` · `weather update` · `weather report` | Default |
| `weather today` · `weather now` | Default |
| `forecast` | Default |
| `how's it looking outside` | Default |
| `what's it like outside` | Default |
| `let me see the weather in Denver` | Denver |
| `what's the weather in Boston` | Boston |
| `how's the weather in London` | London |
| `show me the weather for Paris` | Paris |
| `forecast for Tokyo` | Tokyo |

---

## 10 · Market / Stocks / Crypto

Opens the market dashboard. The detected intent selects a view filter.
Returns a LLM-spoken briefing scoped to the filter.

### Crypto filter

| Example phrase |
|----------------|
| `show crypto` · `check crypto` · `get crypto` · `display crypto` |
| `what's the crypto` · `what is crypto` |
| `crypto` · `crypto prices` · `crypto update` · `crypto market` · `crypto briefing` |
| `bitcoin price` · `ethereum price` · `btc price` · `eth price` · `solana price` · `sol price` |
| `price of bitcoin` · `price of ethereum` · `price of btc` · `price of eth` · `price of solana` |
| `brief me on crypto` · `brief me about crypto` |

### Stocks / Equities filter

| Example phrase |
|----------------|
| `show stocks` · `check stocks` · `show the market` · `open the market` |
| `display equities` · `get the market` · `pull up stocks` |
| `what's the market` · `what is the market` · `what are stocks` |
| `stock briefing` · `market briefing` · `stocks update` · `market update` |
| `market summary` · `stocks overview` · `market report` · `market watchlist` |
| `how are the markets` · `how are stocks` · `how is the market` |
| `markets today` · `markets now` · `markets up` · `markets down` · `markets open` |
| `portfolio briefing` · `portfolio update` · `portfolio summary` · `portfolio check` |
| `brief me on the market` · `brief me about stocks` · `brief me on my portfolio` |
| `NVDA` · `NVIDIA` · `AAPL` · `Apple` · `MSFT` · `Microsoft` |
| `SPY` · `QQQ` · `TSLA` · `Tesla` · `AMZN` · `Amazon` · `GOOG` · `Meta` · `AMD` |

### General / All filter

| Example phrase |
|----------------|
| `financial update` · `financial report` · `financial summary` · `financial briefing` |
| `what's the market` · `what is the market` |
| `brief me on financials` · `brief me about investments` |

---

## 11 · YouTube Feed

Opens the YouTube feed panel. Fetches latest videos from configured channels via RSS.
LLM synthesis runs in the background and Starling delivers a spoken briefing.
Supports filtering by video type (all / long / shorts), by channel, and by sort order.
An in-panel video modal lets you open any video for playback.

**Trigger is highly specific** — only the exact phrases below match; generic "YouTube"
mentions fall through to the LLM.

### Open

| Example phrase |
|----------------|
| `open youtube feed` |
| `view youtube feed` |

### Close (priority 7)

| Example phrase |
|----------------|
| `close youtube` |
| `close feed` |
| `close the youtube feed` |

> **Settings:** Configure default channels via the in-panel ⚙ button or by setting
> `YOUTUBE_CHANNELS` in `.env` (comma-separated channel IDs).

---

## 12 · Reddit Social Feed

Opens the Reddit social feed panel. Fetches top/hot posts from configured subreddits via
the public Reddit JSON API (no auth required). LLM synthesis runs in the background and
Starling delivers a spoken briefing. Supports per-subreddit filter tabs.

**Trigger is highly specific** — only the exact phrases below match; generic "Reddit"
mentions fall through to the LLM.

### Open

| Example phrase |
|----------------|
| `open reddit social` |
| `view reddit social` |

### Close (priority 8)

| Example phrase |
|----------------|
| `close reddit` |
| `close social` |
| `close the reddit feed` |

> **Settings:** Configure default subreddits via the in-panel ⚙ button or by setting
> `REDDIT_SUBREDDITS` in `.env` (comma-separated subreddit names).

---

## 13 · News

Opens the news panel and delivers a spoken briefing. Defaults to world news.
Saying a category keyword anywhere in the phrase selects that feed.

### General triggers

| Example phrase |
|----------------|
| `news briefing` |
| `morning briefing` |
| `daily brief` · `evening brief` · `morning brief` |
| `what's in the news` · `what is the news` |
| `latest news` · `breaking news` · `today's news` |
| `news update` · `news report` · `news summary` · `news roundup` |
| `news headlines` |
| `top stories` · `top headlines` |
| `what's going on` · `what's happening` |
| `catch me up` |
| `brief me` |
| `headlines` |

### Category triggers

Append or include a category keyword anywhere in the phrase.
The category keyword maps to the feed as shown below.

| Keyword(s) | Feed category |
|------------|--------------|
| `tech` · `technology` | Technology |
| `financial` · `finance` · `business` · `economy` · `market news` · `stocks news` | Business |
| `american` · `america` · `united states` · `us` · `usa` | US |
| `science` · `scientific` | Science |
| `health` · `medical` · `medicine` | Health |
| `sports` · `sport` | Sports |
| `entertainment` · `celebrity` · `celebrities` | Entertainment |
| `world` · `global` · `international` | World (default) |

| Example phrase | Category |
|----------------|----------|
| `tech news` | Technology |
| `show me the technology headlines` | Technology |
| `business briefing` | ⚠ falls to LLM — use "business news" or "financial news" |
| `financial news` | Business |
| `us news` · `american news` | US |
| `sports headlines` | Sports |
| `health news` · `medical news` | Health |
| `entertainment headlines` | Entertainment |
| `global news` · `world news` | World |

> **Note:** "business briefing", "financial briefing" etc. route to the **Market** tool,
> not News. To get business news specifically, say "business news" or "financial news".

---

## 14 · Browser / Web Panel

Opens an embedded browser panel (iframe) in the UI. The close phrase is checked at the
highest priority whenever the panel is open. The open trigger fires last — after all other
tools — so that short phrases like `"search"` don't accidentally hijack longer ones.

Page text is extracted server-side and injected as LLM context, enabling on-page Q&A and
summarisation.

### Close (priority 2 — panel must be open)

| Example phrase |
|----------------|
| `close browser` · `close the browser` |
| `exit browser` · `exit the browser` |
| `dismiss browser` · `dismiss the browser` |
| `hide browser` · `hide the browser` |
| `shut browser` · `shut the browser` |

### Wikipedia lookup in browser (priority 25)

Extracts the topic and navigates to the English Wikipedia article in the browser panel.
**Requires "browser" or "browser window" or "in browser" in the phrase.**  
To query the local offline Wikipedia instead, use the **"local wiki"** / **"offline wikipedia"** triggers (priority 12).

| Example phrase | Topic resolved |
|----------------|---------------|
| `browser wikipedia quantum physics` | quantum physics |
| `browser window wikipedia black holes` | black holes |
| `search quantum computing on Wikipedia in browser` | quantum computing |
| `look up Marie Curie on Wikipedia in browser` | Marie Curie |
| `wikipedia in browser for photosynthesis` | photosynthesis |
| `search Wikipedia in the browser window for Alan Turing` | Alan Turing |

### Open URL (priority 25)

Navigates directly to a given URL or bare domain.

| Example phrase | Resolves to |
|----------------|-------------|
| `open browser https://example.com` | `https://example.com` |
| `open browser example.com` | `https://example.com` |
| `open browser news.ycombinator.com` | `https://news.ycombinator.com` |

### Web search (priority 25)

Opens a DuckDuckGo plain-HTML search (iframe-friendly).

| Example phrase | Search query |
|----------------|--------------|
| `browser search for latest AI news` | latest AI news |
| `browser search typescript generics` | typescript generics |

---

## Disambiguation Quick Reference

| Ambiguous phrase | Routes to | Why |
|-----------------|-----------|-----|
| `local wikipedia search quantum physics` | ✅ Wikipedia RAG | "local" keyword present — routes to offline ChromaDB |
| `local wiki black holes` | ✅ Wikipedia RAG | "local" keyword present |
| `offline wikipedia Marie Curie` | ✅ Wikipedia RAG | "offline" keyword present |
| `browser wikipedia quantum physics` | ✅ Browser panel | "browser" keyword present — opens Wikipedia in iframe |
| `look up black holes on Wikipedia in browser` | ✅ Browser panel | "in browser" present — browser takes precedence |
| `search Wikipedia for black holes` | ✅ LLM fallback | Neither "local"/"offline" nor "browser" — falls through to LLM |
| `look up black holes on Wikipedia` | ✅ LLM fallback | No qualifying keyword — falls through to LLM |
| `start journal entry` | ✅ Journal | Journal start trigger matches |
| `show journal` | ✅ Journal | Journal read trigger matches |
| `store idea into the vault` | ✅ Ideas Vault — capture | Both "idea" and "vault" present; capture verb matches |
| `store idea into the bank vault` | ✅ Ideas Vault — capture | "bank" is ignored; both "idea" and "vault" still present |
| `search Wikipedia for bank vaults` | ✅ LLM fallback | No "local"/"offline"/"browser" — vault guard also blocks Ideas Vault |
| `I have a good idea` | ✅ LLM | No "vault" — vault guard blocks Ideas Vault |
| `open ideas vault` | ✅ Ideas Vault — list | No capture verb; routes to list view |
| `stock briefing` | ✅ Market | Market is checked before News |
| `market briefing` | ✅ Market | Market patterns match before News |
| `crypto briefing` | ✅ Market | Crypto patterns match `crypto` bare word |
| `portfolio briefing` | ✅ Market | Explicit portfolio pattern |
| `financial briefing` | ✅ Market | Financial general pattern |
| `brief me` | ✅ News | No market keyword present |
| `brief me on the market` | ✅ Market | Explicit market "brief me" pattern |
| `brief me on crypto` | ✅ Market | Explicit crypto "brief me" pattern |
| `stock news` | ✅ News → Business | "stocks" in news category map |
| `market news` | ✅ News → Business | "market" in news category map |
| `morning briefing` | ✅ News | Explicit news pattern |
| `news briefing` | ✅ News | Explicit news pattern |
| `what's happening` | ✅ News | No market keyword present |
| `what's happening with the market` | ✅ Market | Market checked first; stockPatterns match |
| `timer for 5 minutes` | ✅ Timer | "timer for" pattern, checked before Time |
| `what's the time` | ✅ Time | Not a timer phrase |
| `what day is it` | ✅ Date | Checked before Time |
| `cancel that` | ✅ Dossier exit | Dismisses any open tool panel |

---

## Adding New Trigger Phrases

Each toolkit has its own `detect*Trigger()` function in the corresponding
frontend file. Add patterns to the appropriate array and update this document.

| Tool | File | Function |
|------|------|----------|
| Dossier | `frontend/app.js` | `PRES_TRIGGER_RE` / `_matchesExitPhrase()` |
| Timer | `frontend/timer-panel.js` | `detectTimerTrigger()` |
| Date | `frontend/app.js` | `detectDateTrigger()` |
| Time | `frontend/app.js` | `detectTimeTrigger()` |
| Weather | `frontend/weather-panel.js` | `detectWeatherTrigger()` |
| Market | `frontend/stocks-panel.js` | `detectMarketTrigger()` |
| News | `frontend/news-panel.js` | `detectNewsTrigger()` |
| Browser | `frontend/browser-panel.js` | `detectBrowserTrigger()` / `detectBrowserClose()` |
| Ideas Vault | `frontend/ideas-panel.js` | `detectIdeaCaptureTrigger()` / `detectIdeaReadTrigger()` |
| Voice Journal | `frontend/journal-panel.js` | `detectJournalStartTrigger()` / `detectJournalReadTrigger()` |
| Wikipedia RAG | `frontend/wiki-panel.js` | `detectWikiTrigger()` / `detectWikiExitTrigger()` |
| Calendar | `frontend/calendar-panel.js` | `detectCalendarTrigger()` |
| Mail | `frontend/mail-panel.js` | `detectMailTrigger()` |
| Prompt Editor | `frontend/app.js` | inline regex in `_routeInput()` |

---

## 15 · Calendar

Opens the calendar panel and delivers a spoken briefing of today's and upcoming events.
Fetches via CalDAV from iCloud. Requires an Apple ID and App-Specific Password
(configured in the toolkit login form).

### Open

| Example phrase |
|----------------|
| `show my calendar` |
| `what's on my schedule` |
| `check my calendar` |
| `any meetings today` |
| `open calendar` |
| `calendar for today` |
| `what do I have on today` |
| `sync my calendar` · `refresh my calendar` · `update my calendar` |

---

## 16 · Mail (Apple Mail Inbox)

Opens the mail panel and delivers a spoken inbox briefing. Fetches unread IMAP
messages via `imap.mail.me.com:993`. Only FROM, SUBJECT, and DATE headers are
retrieved — no body content is ever accessed. Results are cached for 5 minutes.

Requires an Apple ID and App-Specific Password configured in the toolkit login form.

### Open

| Example phrase |
|----------------|
| `check my email` |
| `check mail` |
| `view inbox` |
| `show my inbox` |
| `any new emails` |
| `any new messages` |
| `do I have any email` |
| `do I have any unread mail` |
| `what's in my inbox` |
| `what's in my email` |
| `emails this morning` |
| `new mail today` |
| `unread emails` |
| `unread messages` |
| `pull up my email` |
| `open my email` |
| `read my email` |

### Close (priority 9 — checked before dossier exit)

| Example phrase |
|----------------|
| `close mail` |
| `close email` |
| `close inbox` |
| `hide mail` |
| `dismiss mail` |
| `exit mail` |
| `exit email` |
| `exit inbox` |

> **Settings:** Configure Apple ID credentials in the toolkit Mail login form.
> The server defaults to `imap.mail.me.com:993` (override via `IMAP_HOST` / `IMAP_PORT` env vars).
> Cache duration: 5 minutes (override via `MAIL_CACHE_SECONDS` env var).
> Max messages returned: 20 (override via `MAIL_MAX_UNREAD` env var).

---

## 26 · Prompt Registry Editor

Opens the Prompt Registry editor sub-view inside the menu panel.
All registered LLM prompt strings can be viewed, edited, and reset here.

### Open

Regex: `/\b(?:open|show|edit)\b.{0,20}\bprompt(?:s)?\b.{0,20}\b(?:editor|registry|panel|settings)\b/i`

| Example phrase |
|----------------|
| `open prompt editor` |
| `show prompt registry` |
| `edit prompts` / `edit prompt settings` |
| `open prompts panel` |

### Also accessible via

- The **MENU** panel → **PROMPT REGISTRY** section → **OPEN EDITOR** button


---

## 27 · System Status (System Awareness)

Speaks a short summary of Starling's current runtime state: LLM/STT/TTS
backends, available tools, boot duration, and GPU VRAM usage. Backed by
`GET /system/status` (localhost-only).

### Trigger phrases

| Pattern (regex, case-insensitive) | Example phrases |
|-----------------------------------|-----------------|
| `\bsystem\s+status\b`           | `system status` |
| `\bhow\s+are\s+you\s+running\b` | `how are you running` |
| `\bwhat'?s\s+your\s+status\b`   | `what's your status` |
| `\bare\s+you\s+healthy\b`       | `are you healthy` |
| `\bself[-\s]?diagnostic\b`      | `self diagnostic` / `self-diagnostic` |

### Also accessible via

- The **MENU** panel -> **SYSTEM** section -> **SYSTEM STATUS** button (opens the full panel with boot snapshot, tool inventory, last-event metrics, live runtime telemetry, and the injected static prompt block).

### Endpoints

- `GET  /system/status`        - Full payload (localhost only)
- `GET  /system/health`        - Minimal public health probe
- `POST /system/refresh-tools` - Re-probe tool credentials (localhost only)
