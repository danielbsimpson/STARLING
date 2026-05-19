# Starling — Trigger Phrase Reference

All voice (and text) input passes through a **priority-ordered dispatch chain**.
The first matching tool wins; unmatched input falls through to the LLM.

---

## Dispatch Priority Order

| Priority | Tool | Notes |
|----------|------|-------|
| 1 | Browser — close | Only when browser panel is open; checked before everything else |
| 2 | Dossier — exit | |
| 3 | Dossier — open | |
| 4 | Timer | Checked before Time to avoid "timer" matching time patterns |
| 5 | Date | Checked before Time — date phrases are more specific |
| 6 | Time | |
| 7 | Ideas Vault | Both "idea/ideas" **and** "vault" must appear — very low false-positive rate |
| 8 | Weather | |
| 9 | Market / Stocks / Crypto | Checked before News — more specific domain vocabulary |
| 10 | News | |
| 11 | Browser — open | Wikipedia lookups, open URL, or web search |
| 12 | LLM fallback | Anything unmatched |

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

## 2 · Timer

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

## 3 · Date

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

## 4 · Time

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

## 7 · Ideas Vault

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

## 8 · Weather

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

## 8 · Market / Stocks / Crypto

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

## 9 · News

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

## 10 · Browser / Web Panel

Opens an embedded browser panel (iframe) in the UI. The close phrase is checked at the
highest priority whenever the panel is open. The open trigger fires last — after all other
tools — so that short phrases like `"search"` don't accidentally hijack longer ones.

Page text is extracted server-side and injected as LLM context, enabling on-page Q&A and
summarisation.

### Close (priority 1 — panel must be open)

| Example phrase |
|----------------|
| `close browser` · `close the browser` |
| `exit browser` · `exit the browser` |
| `dismiss browser` · `dismiss the browser` |
| `hide browser` · `hide the browser` |
| `shut browser` · `shut the browser` |

### Wikipedia lookup (priority 10)

Extracts the topic and navigates to the English Wikipedia article.

| Example phrase | Topic resolved |
|----------------|---------------|
| `look up black holes on Wikipedia` | black holes |
| `search Wikipedia for the French Revolution` | the French Revolution |
| `open quantum computing on Wikipedia` | quantum computing |
| `find Marie Curie on Wikipedia` | Marie Curie |
| `wikipedia about photosynthesis` | photosynthesis |
| `wikipedia on the Roman Empire` | the Roman Empire |
| `wikipedia for Alan Turing` | Alan Turing |

### Open URL (priority 10)

Navigates directly to a given URL or bare domain.

| Example phrase | Resolves to |
|----------------|-------------|
| `open browser https://example.com` | `https://example.com` |
| `open browser example.com` | `https://example.com` |
| `open browser news.ycombinator.com` | `https://news.ycombinator.com` |

### Web search (priority 10)

Opens a DuckDuckGo plain-HTML search (iframe-friendly).

| Example phrase | Search query |
|----------------|--------------|
| `browser search for latest AI news` | latest AI news |
| `browser search typescript generics` | typescript generics |

---

## Disambiguation Quick Reference

| Ambiguous phrase | Routes to | Why |
|-----------------|-----------|-----|
| `store idea into the vault` | ✅ Ideas Vault — capture | Both "idea" and "vault" present; capture verb matches |
| `store idea into the bank vault` | ✅ Ideas Vault — capture | "bank" is ignored; both "idea" and "vault" still present |
| `search Wikipedia for bank vaults` | ✅ Browser | No "idea/ideas" — vault guard blocks Ideas Vault |
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
