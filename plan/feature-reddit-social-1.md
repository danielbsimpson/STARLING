---
goal: Reddit Social Feed Panel — voice-triggered read-only Reddit integration with per-subreddit filtering and LLM synthesis
version: 1.1
date_created: 2026-05-22
last_updated: 2026-05-22
owner: simps
status: 'Complete'
tags: [feature, social-media, reddit, llm-synthesis, voice-trigger]
---

# Introduction

![Status: Complete](https://img.shields.io/badge/status-Complete-brightgreen)

Adds a Reddit social feed panel to S.T.A.R.L.I.N.G. triggered exclusively by the phrases **"Open Reddit social"** or **"View Reddit social"**. The panel fetches the hottest/trending posts (max 10 per subreddit) from a configurable list of subreddits and, optionally, auto-discovers subreddits from the authenticated user's Reddit subscriptions via PRAW. Posts are displayed in a scrollable panel with per-subreddit filter tabs. The local LLM synthesises post content in the background (identical pattern to the news panel) and Starling delivers a spoken briefing once synthesis completes.

---

## 1. Requirements & Constraints

- **REQ-001**: The voice trigger MUST match only the exact phrases "Open Reddit social" or "View Reddit social" (case-insensitive). Generic terms like "reddit", "read it", or "show me posts" must NOT activate this panel.
- **REQ-002**: Subreddits are configured via the `REDDIT_SUBREDDITS` env var (comma-separated, no auth). If PRAW credentials are present in `.env`, the system auto-fetches the user's subscribed subreddits instead.
- **REQ-003**: Each subreddit fetch requests `hot` sort with a max of 10 posts. Sort is configurable per-request via the `sort` query parameter (hot/top/new/rising).
- **REQ-004**: All Reddit posts are fetched as read-only. No posting, voting, or commenting is implemented.
- **REQ-005**: The backend must cache results with a configurable TTL (`REDDIT_CACHE_SECONDS`, default 900 seconds). Stale-while-revalidate: serve cache immediately while re-fetching in background when TTL expires.
- **REQ-006**: Post synthesis must follow the identical background-task-plus-polling pattern used in `backend/news.py` (`_run_synthesis_bg` → `GET /reddit/synthesised` polling).
- **REQ-007**: The `llm_context` field in the API response must be injectable as an ephemeral system message to Ollama/llama-server via the existing `sendToOllama(prompt, { extraContext })` pattern in `frontend/app.js`.
- **REQ-008**: When synthesis completes, Starling must automatically speak a brief verbal summary of the top posts per subreddit via `enqueueSpeak()`.
- **REQ-009**: The panel must include a "All" tab and one tab per subreddit so the user can filter displayed posts by subreddit.
- **REQ-010**: Post cards must display: subreddit name, post title, upvote score (↑), comment count (💬), author handle, and human-readable age (e.g. "3h ago").
- **REQ-011**: A refresh button must clear the cache for the current subreddit set and re-fetch live data.
- **REQ-012**: The close trigger must respond to "close Reddit", "close social", and the standard panel exit phrases used by existing panels.

- **SEC-001**: The Reddit public JSON API (`/r/{subreddit}/hot.json`) must be called with a descriptive `User-Agent` header to comply with Reddit's API rules: `STARLING/1.0 (personal assistant; read-only; contact: local)`.
- **SEC-002**: PRAW credentials (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`) must be stored exclusively in `.env` and never logged, echoed in responses, or committed to version control.
- **SEC-003**: Subreddit names from env vars must be sanitised before interpolation into URLs (alphanumeric + underscore only, max 50 chars, regex: `^[A-Za-z0-9_]{1,50}$`).
- **SEC-004**: Post `selftext` and `title` fields returned from Reddit must be truncated and stripped of HTML before storage or display to prevent XSS in the panel DOM. Use `element.textContent =` not `innerHTML =` for user-sourced strings.

- **CON-001**: No new Python dependencies are required for the no-auth path (httpx already present). PRAW (`praw>=7.7.0`) is added only for Phase 2 subscription discovery.
- **CON-002**: The Reddit public JSON API enforces rate limits: max 60 requests/minute without auth, 100/minute with OAuth. With 10 configured subreddits and a 15-minute cache, this is well within limits.
- **CON-003**: Home-timeline feed (personalised Reddit front page) is NOT implemented — it requires user-context OAuth tokens beyond what a Script-type PRAW app provides. Only the user's subscribed subreddit list is fetched; posts are pulled from each subreddit's `/hot` feed.
- **CON-004**: The panel must reuse existing CSS variables and class conventions from `frontend/style.css`. No external CSS libraries may be added.
- **CON-005**: The backend file must be self-contained (no circular imports). It must import only from the Python standard library, `httpx`, `fastapi`, `praw` (optional), and `session_log`.

- **GUD-001**: Follow the exact same file/function/naming conventions as `backend/news.py` and `frontend/news-panel.js` — they are the canonical reference implementations for this feature.
- **GUD-002**: All cache writes must be atomic (write to a `.tmp` file then `os.replace()`), same as other memory files in the project.
- **GUD-003**: Panel JS must use `export function` for all public API functions (same pattern as news-panel.js).
- **GUD-004**: Synthesis prompt must request plain-prose output with zero markdown (same constraint as `NEWS_SYNTHESIS_PROMPT` in news.py) since the output is read aloud by TTS.

- **PAT-001**: Background synthesis: `BackgroundTasks.add_task(_run_synthesis_bg, posts, subreddit_key)` fired after `GET /reddit` returns raw data — identical to `GET /news` pattern.
- **PAT-002**: Synthesis polling: frontend calls `GET /reddit/synthesised` every 3 seconds (max 40 attempts) — identical to `_startSynthesisPolling()` in news-panel.js.
- **PAT-003**: LLM injection: `sendToOllama(userPrompt, { extraContext: [{ role: 'system', content: data.llm_context }] })` — identical to the news briefing pattern in app.js.

---

## 2. Implementation Steps

### Implementation Phase 1 — Backend: Core Reddit Fetching (No Auth)

- GOAL-001: Create `backend/reddit.py` with public subreddit post fetching, in-memory caching, background LLM synthesis, and three REST endpoints. No authentication required for this phase.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `backend/reddit.py`. Add module docstring. Import: `asyncio`, `json`, `logging`, `os`, `re`, `time`, `datetime`, `httpx`, `fastapi.APIRouter`, `fastapi.BackgroundTasks`, `fastapi.Query`, `session_log`. Declare `router = APIRouter()` and `logger = logging.getLogger(__name__)`. | ✅ | 2026-05-22 |
| TASK-002 | Add config block to `backend/reddit.py`. Read env vars: `REDDIT_SUBREDDITS` (default `"worldnews,technology,science,gaming"`), `REDDIT_LIMIT_PER_SUB` (default `10`, cast to int), `REDDIT_CACHE_SECONDS` (default `900`, cast to int), `REDDIT_SORT` (default `"hot"`), `REDDIT_SYNTHESIS_ENABLED` (default `"true"`, normalise to bool). Parse `REDDIT_SUBREDDITS` into `_DEFAULT_SUBS: list[str]` by splitting on commas, stripping whitespace, and filtering to names matching `^[A-Za-z0-9_]{1,50}$`. | ✅ | 2026-05-22 |
| TASK-003 | Add in-memory cache dicts to `backend/reddit.py`: `_raw_cache: dict = {}` (key: `"reddit_all"` or `"reddit_{sub}"`), `_synth_cache: dict = {}` (same keys), `_synth_busy: set = set()`. Also define `REDDIT_SYNTHESIS_PROMPT` string constant (see TASK-005 for prompt text). | ✅ | 2026-05-22 |
| TASK-004 | Implement `async def _fetch_subreddit_posts(subreddit: str, sort: str = "hot", limit: int = 10) -> list[dict]` in `backend/reddit.py`. Use `httpx.AsyncClient(timeout=10.0)`. URL: `https://www.reddit.com/r/{subreddit}/{sort}.json?limit={limit}&raw_json=1`. Headers: `{"User-Agent": "STARLING/1.0 (personal assistant; read-only; contact: local)"}`. On non-200 or exception, log warning and return `[]`. Parse `response.json()["data"]["children"]`. For each child `c["data"]`, build a post dict with keys: `id` (c["data"]["id"]), `title` (strip + truncate 300 chars), `score` (int), `num_comments` (int), `author` (f"u/{c['data']['author']}" or "[deleted]"), `subreddit` (c["data"]["subreddit"]), `url` (c["data"]["url"]), `permalink` (f"https://www.reddit.com{c['data']['permalink']}"), `selftext` (strip HTML tags, truncate 280 chars), `is_self` (bool), `created_utc` (float), `age` (human-readable relative time, e.g. "3h ago"), `flair` (c["data"].get("link_flair_text") or None), `thumbnail` (c["data"]["thumbnail"] if it starts with "http" else None). Return list of post dicts. | ✅ | 2026-05-22 |
| TASK-005 | Define `REDDIT_SYNTHESIS_PROMPT` constant in `backend/reddit.py`. Prompt text (verbatim): `"""You are a social media analyst summarising Reddit posts for a voice assistant.\nBelow is a JSON array of top Reddit posts from one or more subreddits.\nFor each subreddit present, produce a brief spoken summary of its top 3 posts.\nReturn ONLY a valid JSON object with:\n- "briefing": a plain-prose spoken summary covering all subreddits (1-2 sentences per subreddit, no markdown)\n- "by_subreddit": an object mapping each subreddit name to { "summary": "...", "top_posts": ["title1", "title2", "title3"] }\nDo not use asterisks, hyphens as bullet points, or any markdown formatting in "briefing" since it will be read aloud.\nPosts:\n{posts_json}\n"""`. | ✅ | 2026-05-22 |
| TASK-006 | Implement `async def _fetch_all_parallel(subreddits: list[str], sort: str, limit: int) -> tuple[list[dict], dict[str, list[dict]]]` in `backend/reddit.py`. Use `asyncio.gather(*[_fetch_subreddit_posts(sub, sort, limit) for sub in subreddits], return_exceptions=True)`. Build `by_subreddit: dict[str, list[dict]]` from results (skip exceptions). Build flat `all_posts: list[dict]` sorted by `score` descending. Return `(all_posts, by_subreddit)`. | ✅ | 2026-05-22 |
| TASK-007 | Implement `def _human_age(created_utc: float) -> str` in `backend/reddit.py`. Compute `delta = time.time() - created_utc`. Return `"Xm ago"` if < 3600, `"Xh ago"` if < 86400, `"Xd ago"` otherwise. | ✅ | 2026-05-22 |
| TASK-008 | Implement `def _build_llm_context(posts: list[dict], subreddits: list[str]) -> str` in `backend/reddit.py`. Format: `f"[REDDIT FEED — {datetime.now(timezone.utc).strftime('%A, %B %d at %I:%M %p UTC')}]\n"` followed by `f"r/{sub}:\n" + newline-joined `f"  {i}. {p['title']} (↑{p['score']} | {p['num_comments']} comments)"` for each post. Cap at `REDDIT_LIMIT_PER_SUB` posts per subreddit. | ✅ | 2026-05-22 |
| TASK-009 | Implement `async def _synthesise_posts(posts: list[dict]) -> dict | None` in `backend/reddit.py`. Cap input to 50 posts. Build `capped` list with keys: `subreddit`, `title`, `score`, `num_comments`. Format `REDDIT_SYNTHESIS_PROMPT` with `json.dumps(capped)`. Call local LLM using the same dual-backend pattern as `_synthesise_headlines()` in news.py (check `LLM_BACKEND` env var, build payload for Ollama or llama-server, POST with `stream=False`, parse response). On success parse JSON and return the dict (must have `"briefing"` and `"by_subreddit"` keys). Return `None` on any failure. | ✅ | 2026-05-22 |
| TASK-010 | Implement `async def _run_synthesis_bg(posts: list[dict], cache_key: str)` in `backend/reddit.py`. Pattern is identical to `_run_synthesis_bg` in news.py: add `cache_key` to `_synth_busy`, call `await _synthesise_posts(posts)`, on success write `{"ts": time.time(), "result": result}` to `_synth_cache[cache_key]`, log result, discard from `_synth_busy` in `finally`. | ✅ | 2026-05-22 |
| TASK-011 | Implement `GET /reddit` endpoint in `backend/reddit.py`. Signature: `async def get_reddit(subreddit: str = Query(None), sort: str = Query(None), limit: int = Query(None), background_tasks: BackgroundTasks = BackgroundTasks())`. Logic: (1) resolve subreddit list: if `subreddit` param given, use `[subreddit]`, else use `_DEFAULT_SUBS` (or PRAW-fetched list if Phase 2 is implemented); (2) sanitise all subreddit names (reject names not matching `^[A-Za-z0-9_]{1,50}$` with 400 error); (3) resolve `sort` (param → env default → "hot") and `limit` (param → env default → 10, clamp to 1-25); (4) compute `cache_key = "reddit_" + "_".join(sorted(subreddits))`; (5) serve from `_raw_cache` if fresh (age < `_CACHE_SECONDS`), re-trigger synthesis if needed; (6) otherwise call `_fetch_all_parallel`, build response dict with keys: `posts`, `by_subreddit`, `subreddits`, `total`, `llm_context`, `fetched_at`, `cache_age`, `sort`, `synthesis_enabled`, `synthesis_status`; (7) write to `_raw_cache[cache_key]`; (8) if synthesis enabled and not busy, `background_tasks.add_task(_run_synthesis_bg, all_posts, cache_key)` and pop stale synth cache; (9) call `session_log.log(...)` with endpoint + result summary; (10) return response dict. | ✅ | 2026-05-22 |
| TASK-012 | Implement `GET /reddit/synthesised` polling endpoint in `backend/reddit.py`. Signature: `async def get_reddit_synthesised(subreddit: str = Query(None))`. Recompute `cache_key` using same logic as TASK-011. Check `_synth_cache` for ready result → return `{"status": "ready", "result": ...}`. Check `_synth_busy` → return `{"status": "pending"}`. Otherwise return `{"status": "none"}`. | ✅ | 2026-05-22 |
| TASK-013 | Implement `DELETE /reddit/cache` endpoint in `backend/reddit.py`. Clear `_raw_cache`, `_synth_cache`, `_synth_busy`. Return `{"status": "cleared"}`. | ✅ | 2026-05-22 |
| TASK-014 | Register `reddit_router` in `backend/main.py`. Add import: `from reddit import router as reddit_router`. Add `app.include_router(reddit_router)` after the existing `app.include_router(log_router)` line. | ✅ | 2026-05-22 |

### Implementation Phase 2 — Backend: PRAW Subscription Discovery (Authenticated)

- GOAL-002: Add optional PRAW-based auto-discovery of the user's Reddit subscriptions. Falls back gracefully to `REDDIT_SUBREDDITS` env var when PRAW credentials are absent.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | Add `praw>=7.7.0` to `requirements.txt` under the comment `# Reddit social feed (Phase 2 — subscription discovery)`. | ✅ | 2026-05-22 |
| TASK-016 | Add PRAW config block to `backend/reddit.py`. Read env vars: `REDDIT_CLIENT_ID` (default `""`), `REDDIT_CLIENT_SECRET` (default `""`), `REDDIT_USERNAME` (default `""`), `REDDIT_PASSWORD` (default `""`). Define `_PRAW_CONFIGURED: bool = all([REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD])`. If `_PRAW_CONFIGURED`, import `praw` inside the block (so the module still loads without praw installed). | ✅ | 2026-05-22 |
| TASK-017 | Implement `async def _fetch_user_subscriptions() -> list[str]` in `backend/reddit.py`. If not `_PRAW_CONFIGURED`, return `_DEFAULT_SUBS`. Run PRAW call in executor (it is synchronous): `loop.run_in_executor(None, _praw_get_subs)` where `_praw_get_subs` is a sync inner function that creates `praw.Reddit(client_id=..., client_secret=..., username=..., password=..., user_agent="STARLING/1.0")` and calls `[s.display_name for s in reddit.user.subreddits(limit=100)]`. Cache result in `_subs_cache` dict with a 3600-second TTL. On any PRAW exception, log warning and return `_DEFAULT_SUBS`. | ✅ | 2026-05-22 |
| TASK-018 | Implement `GET /reddit/subscriptions` endpoint in `backend/reddit.py`. Calls `await _fetch_user_subscriptions()` and returns `{"subreddits": [...], "source": "praw" | "env", "count": N}`. Used by the frontend refresh flow to populate the filter tab list. | ✅ | 2026-05-22 |
| TASK-019 | Update `GET /reddit` endpoint (TASK-011) to call `await _fetch_user_subscriptions()` when no explicit `subreddit` query param is given, so the full subscribed list is fetched automatically when PRAW is configured. | ✅ | 2026-05-22 |

### Implementation Phase 3 — Frontend: Reddit Panel JS

- GOAL-003: Create `frontend/reddit-panel.js` with trigger detection, data fetching, panel rendering, synthesis polling, and LLM briefing injection — following the exact structure of `frontend/news-panel.js`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | Create `frontend/reddit-panel.js`. Add module docstring comment. Declare `const BACKEND_BASE_REDDIT = 'http://localhost:8000'`. Declare DOM ref constants (to be populated once HTML is added in Phase 4): `redditPanel`, `redditMeta`, `redditTitle`, `redditPostList`, `redditFetched`, `redditRefreshBtn`, `redditFilterBar`, `redditSynthIndicator`. Add module-level state vars: `_redditData = null`, `_activeSubreddit = 'all'`, `_synthPollTimer = null`, `_synthPollCount = 0`. Define constants: `SYNTH_POLL_INTERVAL_MS = 3000`, `SYNTH_POLL_MAX = 40`. | ✅ | 2026-05-22 |
| TASK-021 | Implement `export function detectRedditTrigger(transcript)` in `frontend/reddit-panel.js`. Match against the single strict regex: `/\b(?:open|view)\s+reddit\s+social\b/i`. Return `true` if matched, `null` otherwise. No other phrases should match. Do NOT match "reddit", "show reddit", "read it", etc. | ✅ | 2026-05-22 |
| TASK-022 | Implement `export async function openRedditPanel(options = {})` in `frontend/reddit-panel.js`. Params: `options.subreddit` (optional string), `options.sort` (optional, default "hot"), `options.silent` (bool). Steps: (1) set `_activeSubreddit = 'all'`; (2) set meta text to "LOADING…"; (3) build fetch URL: `/reddit` with optional `?subreddit=` and `?sort=` params; (4) fetch with try/catch, show error state on failure; (5) store response in `_redditData`; (6) call `_renderPanel(data)`; (7) show panel by removing `hidden` class; (8) if `data.synthesis_enabled`, call `_startSynthesisPolling(data.subreddits, data.total)`; (9) return `data.llm_context`. | ✅ | 2026-05-22 |
| TASK-023 | Implement `export function closeRedditPanel()` in `frontend/reddit-panel.js`. Add `hidden` class to `redditPanel`. Set `_redditData = null`. Call `_stopSynthesisPolling()`. | ✅ | 2026-05-22 |
| TASK-024 | Implement `export function initRedditPanel({ enqueueSpeak, sendToOllama })` in `frontend/reddit-panel.js`. Store `enqueueSpeak` and `sendToOllama` references in module-level variables. Wire up `redditRefreshBtn` click handler: clear cache via `DELETE /reddit/cache`, then call `openRedditPanel({ silent: true })`. | ✅ | 2026-05-22 |
| TASK-025 | Implement `function _renderPanel(data)` in `frontend/reddit-panel.js`. (1) Set panel title to `"REDDIT SOCIAL FEED"`. (2) Set meta to `"${data.total} POSTS"`. (3) Set fetched timestamp. (4) Build filter bar: render "All" button + one button per subreddit in `data.subreddits`. Attach click handlers that set `_activeSubreddit` and call `_renderPostList()`. (5) Call `_renderPostList()`. | ✅ | 2026-05-22 |
| TASK-026 | Implement `function _renderPostList()` in `frontend/reddit-panel.js`. Filter `_redditData.posts` by `_activeSubreddit` (show all if `=== 'all'`, otherwise filter by `post.subreddit === _activeSubreddit`). Clear `redditPostList`. For each post, create a card element with: subreddit badge (`r/${post.subreddit}`), title text (set via `textContent`), score line (`↑ ${post.score}`), comments line (`💬 ${post.num_comments}`), author (`${post.author}`), age (`${post.age}`). If post has `thumbnail`, add an `<img>` element (set `src` attribute, add `onerror` to hide on fail). Append card to list. | ✅ | 2026-05-22 |
| TASK-027 | Implement synthesis polling functions `_startSynthesisPolling(subreddits, rawCount)` and `_stopSynthesisPolling()` in `frontend/reddit-panel.js`. Pattern is identical to `_startSynthesisPolling` / `_stopSynthesisPolling` in `news-panel.js`. Polling URL: `GET /reddit/synthesised`. On `status === 'ready'`: call `_stopSynthesisPolling()`, patch `_redditData.synthesis = result`, update meta to `"SYNTHESISED"`, and if `_activeSubreddit === 'all'` re-render with synthesis overlay. Then call `_speakBriefing(result.briefing)` to trigger Starling's spoken summary. | ✅ | 2026-05-22 |
| TASK-028 | Implement `function _speakBriefing(briefingText)` in `frontend/reddit-panel.js`. If `briefingText` is a non-empty string and `enqueueSpeak` is set, call `enqueueSpeak(briefingText)`. | ✅ | 2026-05-22 |

### Implementation Phase 4 — Frontend: HTML Panel Structure

- GOAL-004: Add the Reddit panel HTML container to `frontend/index.html` and wire all imports, init calls, and trigger dispatch into `frontend/app.js`.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-029 | Add the following HTML block to `frontend/index.html` inside the `<div class="body-cols">` section, after the existing `<!-- ideas panel -->` or nearest logical sibling panel div. Structure: `<div class="reddit-panel hidden" id="reddit-panel">` containing: (a) a header row with `<div class="reddit-title" id="reddit-title">REDDIT SOCIAL FEED</div>` + `<div class="reddit-meta" id="reddit-meta">—</div>` + `<button class="reddit-refresh-btn" id="reddit-refresh-btn">↻ REFRESH</button>` + `<button class="reddit-close-btn" id="reddit-close-btn">✕</button>` + `<div class="reddit-synth-indicator hidden" id="reddit-synth-indicator">SYNTHESISING…</div>`; (b) `<div class="reddit-filter-bar" id="reddit-filter-bar"></div>` (populated dynamically by JS); (c) `<div class="reddit-post-list" id="reddit-post-list"></div>`; (d) `<div class="reddit-fetched" id="reddit-fetched">—</div>`. | ✅ | 2026-05-22 |
| TASK-030 | Add CSS rules to `frontend/style.css` for the Reddit panel. Follow the visual conventions of the news panel (`.news-panel`, `.news-list`, `.news-card`). Classes to add: `.reddit-panel` (hidden by default, same slide-in behaviour as news-panel — reference `.news-panel` for width, background, border, z-index, overflow, transition rules), `.reddit-filter-bar` (horizontal scroll row of small buttons, `display: flex; gap: 0.4rem; overflow-x: auto; padding: 0.5rem 0`), `.reddit-filter-btn` (pill button, inactive + active states using existing CSS variables `--accent` and `--bg-2`), `.reddit-post-list` (scrollable container, `overflow-y: auto`), `.reddit-post-card` (card layout matching `.news-card` visual style), `.reddit-post-card .reddit-sub-badge` (small accent-coloured label), `.reddit-post-card .reddit-post-title` (prominent text), `.reddit-post-card .reddit-post-stats` (smaller row for score + comments + author + age), `.reddit-post-card .reddit-post-thumb` (right-aligned thumbnail, max-width 80px). `.reddit-synth-indicator` follows `.news-synth-indicator` styling (pulsing dot + label). Also added `.reddit-close-btn` matching wiki-close-btn pattern. | ✅ | 2026-05-22 |
| TASK-031 | Add import to `frontend/app.js`. After the existing import block at the top of the file, add: `import { detectRedditTrigger, openRedditPanel, closeRedditPanel, initRedditPanel } from './reddit-panel.js';` | ✅ | 2026-05-22 |
| TASK-032 | Add `initRedditPanel({ enqueueSpeak, sendToOllama: sendToOllama })` call in `frontend/app.js` at the point where other panels are initialised (locate the `initWeatherPanel`, `initTimerPanel` etc. call block and add the Reddit init call alongside them). | ✅ | 2026-05-22 |
| TASK-033 | Add Reddit trigger detection in `frontend/app.js` inside the `handleTranscript()` function (or equivalent main dispatch function). Place the check BEFORE the general chat fallback. Pattern: `const redditMatch = detectRedditTrigger(transcript); if (redditMatch) { const ctx = await openRedditPanel({}); if (ctx) { sendToOllama("Briefly tell me what's trending on Reddit right now.", { extraContext: [{ role: 'system', content: ctx }] }); } return; }` Log event via `logEvent('tool_trigger', { tool: 'reddit', transcript })`. | ✅ | 2026-05-22 |
| TASK-034 | Add Reddit close detection in `frontend/app.js`. In the panel close dispatch block (where `closeNewsPanel`, `closeWeatherPanel` etc. are checked), add: check for `/\bclose\s+(?:reddit|social)\b/i` or the standard exit phrases, then call `closeRedditPanel()`. Also wired `reddit-close-btn` click handler (matching wiki-close-btn pattern). | ✅ | 2026-05-22 |

---

## 3. Alternatives

- **ALT-001**: Use `feedparser` to parse `https://www.reddit.com/r/{subreddit}/hot.rss` instead of the JSON API. Rejected because RSS gives fewer fields (no score, no comment count, no flair, no thumbnail URL), making post cards less informative.
- **ALT-002**: Use the `asyncpraw` package (async PRAW) instead of running sync PRAW in an executor. Rejected because it adds a dependency and PRAW's sync API is simple to offload via `loop.run_in_executor`. Revisit if PRAW calls become a bottleneck.
- **ALT-003**: Build a separate panel per platform (e.g. `reddit-panel`, `youtube-panel`) within a unified social panel wrapper with tab navigation. Rejected for this phase because Reddit is being implemented standalone first; multi-platform tabs can be added in a future `feature-social-hub` plan without changing this feature's architecture.
- **ALT-004**: Use `PRAW` to also fetch post content instead of the unauthenticated JSON endpoint. Rejected for Phase 1 because the public API is sufficient for public subreddits and avoids the setup burden for users who don't want to create a Reddit app.
- **ALT-005**: Looser trigger such as "show me Reddit" or just "Reddit". Rejected per user specification — the trigger must be specific enough to never fire during normal conversation containing words like "read it", "Reddit-style", etc.

---

## 4. Dependencies

- **DEP-001**: `httpx>=0.27.0` — already in `requirements.txt`. Used for async HTTP calls to the Reddit public JSON API.
- **DEP-002**: `fastapi>=0.111.0` — already in `requirements.txt`. APIRouter, Query, BackgroundTasks.
- **DEP-003**: `praw>=7.7.0` — added to `requirements.txt` in TASK-015 (Phase 2 only). Required for OAuth-based subscription discovery. Not required for Phase 1.
- **DEP-004**: `session_log` — existing internal module at `backend/session_log.py`. Used for `session_log.log("tool_call", ...)` and `session_log.log("tool_result", ...)`.
- **DEP-005**: Reddit Developer Application — required only for Phase 2. User must create a "Script" type app at `https://www.reddit.com/prefs/apps`. Fields needed: `client_id` (14-character alphanumeric), `client_secret` (27-character alphanumeric). These map to `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` in `.env`.
- **DEP-006**: `.env` file — must be updated with: `REDDIT_SUBREDDITS`, `REDDIT_CACHE_SECONDS`, `REDDIT_LIMIT_PER_SUB`, `REDDIT_SYNTHESIS_ENABLED` (Phase 1) and optionally `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` (Phase 2).

---

## 5. Files

- **FILE-001**: `backend/reddit.py` — **CREATE** — New FastAPI router module. All backend Reddit logic: post fetching, caching, synthesis, and subscription discovery.
- **FILE-002**: `backend/main.py` — **MODIFY** — Add `from reddit import router as reddit_router` and `app.include_router(reddit_router)`.
- **FILE-003**: `frontend/reddit-panel.js` — **CREATE** — New frontend module. Trigger detection, panel lifecycle, DOM rendering, synthesis polling, spoken briefing.
- **FILE-004**: `frontend/index.html` — **MODIFY** — Add `<div id="reddit-panel" class="reddit-panel hidden">` HTML structure.
- **FILE-005**: `frontend/style.css` — **MODIFY** — Add CSS rules for `.reddit-panel`, `.reddit-post-card`, `.reddit-filter-bar`, `.reddit-filter-btn`, `.reddit-post-stats`, `.reddit-sub-badge`, `.reddit-post-thumb`, `.reddit-synth-indicator`.
- **FILE-006**: `frontend/app.js` — **MODIFY** — Add import, initRedditPanel call, trigger detection branch, and close detection branch.
- **FILE-007**: `requirements.txt` — **MODIFY** — Add `praw>=7.7.0` (Phase 2 only).
- **FILE-008**: `.env` — **MODIFY** (user action) — Add `REDDIT_SUBREDDITS`, optional `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`.

---

## 6. Testing

- **TEST-001**: `GET /reddit` with no params returns 200 with `posts` array containing items from default subreddits. Each post has required keys: `id`, `title`, `score`, `num_comments`, `author`, `subreddit`, `permalink`, `age`.
- **TEST-002**: `GET /reddit?subreddit=worldnews` returns posts exclusively from `r/worldnews`. Verify `subreddit` field on all posts equals `"worldnews"`.
- **TEST-003**: `GET /reddit?subreddit=invalid__name!!` returns HTTP 400 with a validation error message.
- **TEST-004**: `GET /reddit` called twice within `REDDIT_CACHE_SECONDS` returns the second response from cache (`cache_age > 0`).
- **TEST-005**: `DELETE /reddit/cache` followed by `GET /reddit` results in a fresh fetch (`cache_age === 0`).
- **TEST-006**: `GET /reddit/synthesised` returns `{"status": "pending"}` within ~2 seconds of the first `GET /reddit` call (synthesis background task is running), then `{"status": "ready", "result": {...}}` after LLM completes.
- **TEST-007**: `GET /reddit/subscriptions` with PRAW not configured returns `{"source": "env", "subreddits": [...]}` matching the `REDDIT_SUBREDDITS` env var.
- **TEST-008**: Voice trigger — speaking the exact phrase "Open Reddit social" must activate `openRedditPanel()` and NOT trigger any other panel or general chat handler.
- **TEST-009**: Voice trigger — speaking "read it again", "tell me about Reddit", "that's a reddit thing" must NOT activate the Reddit panel.
- **TEST-010**: After panel opens, synthesis completes (TEST-006), and `_speakBriefing()` is called — verify `enqueueSpeak` receives a non-empty plain-prose string with no markdown characters (`*`, `#`, `-`).
- **TEST-011**: Filter tab "r/technology" clicked → only technology posts visible in panel. "All" tab clicked → all posts restored.
- **TEST-012**: Refresh button click triggers `DELETE /reddit/cache` then re-fetches live data and re-renders the panel.
- **TEST-013**: Close phrase "close Reddit social" hides panel and clears `_redditData`.
- **TEST-014** (Phase 2): With valid PRAW credentials in `.env`, `GET /reddit/subscriptions` returns `{"source": "praw", ...}` with the user's actual subscribed subreddit list.

---

## 7. Risks & Assumptions

- **RISK-001**: Reddit's public JSON API (`/r/{sub}/hot.json`) may return 429 Too Many Requests if the server is restarted repeatedly during development and the cache is cleared often. Mitigation: the 15-minute cache (900s default) keeps request volume well below limits in production use. In development, increase `REDDIT_LIMIT_PER_SUB` temporarily and rely on the cache.
- **RISK-002**: Reddit periodically changes their API policies (as seen in 2023 with third-party app restrictions). The current approach (unauthenticated public JSON for public subreddits) has been stable and is explicitly permitted in Reddit's API terms. PRAW Script-type auth for personal use is also explicitly permitted. Monitor for policy changes.
- **RISK-003**: PRAW's `reddit.user.subreddits()` call may be slow (1-3s) on first use. Mitigation: the subscription list is cached in-memory with a 3600-second TTL, so the slow path only triggers on startup and hourly refreshes.
- **RISK-004**: LLM synthesis may produce markdown formatting (bold, bullets) despite the explicit prompt instruction. Mitigation: add a post-processing step in `_synthesise_posts()` to strip `*`, `#`, `-` bullet markers from the `briefing` string before caching.
- **RISK-005**: Reddit post titles may contain special characters (HTML entities, Unicode) that break TTS pronunciation. Mitigation: apply Python's `html.unescape()` to titles and `selftext` in `_fetch_subreddit_posts()`.
- **ASSUMPTION-001**: The user's Reddit account is a standard personal account (not a new-UI-only account). PRAW Script-type auth works with standard accounts. If the account uses Reddit's new auth flow (no password login), the Script app type will not work and the user will need to use the `REDDIT_SUBREDDITS` env var instead.
- **ASSUMPTION-002**: The LLM model configured in `.env` (Ollama or llama-server) is capable of returning valid JSON when prompted. The synthesis prompt explicitly requests JSON-only output. If the model is unable to follow this instruction reliably, synthesis will fail gracefully and the panel will display raw posts.
- **ASSUMPTION-003**: The existing `backend/session_log.py` `log()` function is thread-safe and non-blocking. Based on review of other callers, this appears to be the case.

---

## 8. Related Specifications / Further Reading

- [backend/news.py](../backend/news.py) — Canonical reference for the fetch/cache/synthesis/llm_context backend pattern.
- [frontend/news-panel.js](../frontend/news-panel.js) — Canonical reference for the trigger/fetch/render/synthesis-polling frontend pattern.
- [frontend/app.js](../frontend/app.js) — Panel init, trigger dispatch, and LLM injection patterns.
- [Reddit Public JSON API documentation](https://www.reddit.com/dev/api/) — Official API reference. The unauthenticated `.json` suffix endpoint is described under "listings".
- [PRAW Documentation — Script App Authentication](https://praw.readthedocs.io/en/stable/getting_started/quick_start.html) — Setup guide for Script-type Reddit apps used in Phase 2.
- [Reddit App Registration](https://www.reddit.com/prefs/apps) — Where to create the Script-type app for Phase 2 credentials.
