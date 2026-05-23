# ✅ Youtube cannot open videos
The videos that open in the browser window cannot display or show anything. This is the same for google.com, where it says cannot display and asks you to click on a link that opens a new tab. I would like to have the functionality inside the Starling system to view videos.

**RESOLVED (May 2026).** YouTube watch pages block iframe embedding via `X-Frame-Options`. Fixed by rewriting the video URL to the embeddable `/embed/<id>?autoplay=1` format before passing it to the browser panel (`frontend/youtube-panel.js` — new `_toYouTubeEmbedUrl()` helper called in the tile click handler). Added a matching exemption for `youtube.com/embed/` in `_isKnownBlocked()` in `frontend/browser-panel.js` so the URL is no longer treated as a blocked domain.

# ✅ Browser displays off-screen when opening youtube video
The browser window displays to the right of the YouTube panel when a video is clicked, this causes it to appear off screen for most monitors. It should simply appear on screen where the browser normally displays.

**RESOLVED (May 2026).** When the browser panel opened while `yt-mode` was active, both layout modes competed for screen width (35% + 62% + 63% = off-screen). Fixed in `_showPanel()` in `frontend/browser-panel.js` — it now strips all active content-mode classes (`yt-mode`, `news-mode`, `reddit-mode`, `mkt-mode`, `weather-mode`, `pres-mode`) before adding `browser-mode`, so the browser panel always gets the full expected layout space.

# ✅ On shutdown, GPU Dedicated memory still being utilized at 50%
When I activate the shutdown, the GPU dedicated memory drops to about 50% of the total utilization when the system is running. It seems like everything closes down in the terminal, and pressing crtl+c doesn't do anything; but once I manually close the terminal in VSCode, then the dedicated GPU memory drops down to normal idle state. It seems the shutdown is not fully shutting down the system.

**RESOLVED (May 2026).** `scripts/stop.py` was calling `taskkill /F /PID` without the `/T` flag, which killed only the parent `llama-server.exe` process and left its GPU worker child processes running (holding CUDA/VRAM). Added `/T` to propagate the kill to the entire process tree — `taskkill /F /T /PID` — which fully releases dedicated GPU memory on shutdown.

# ✅ News summaries are too aggressive
The news summary function sometimes combines stories instead of simply grouping the same headlines into a single headline. Improve the pipeline with intelligent LLM usage. Multiple LLM calls to identify if a headline is the same as another (same story, same topic).

**RESOLVED (May 2026).** Replaced the single-stage LLM synthesis with a two-stage hybrid pipeline in `backend/news.py`:

- **Stage 1 — String-similarity dedup** (`_fuzzy_dedup_headlines`): Uses `difflib.SequenceMatcher` with a 0.72 ratio threshold to collapse near-identical headlines from different outlets before the LLM is involved. Deterministic, fast, no inference cost.
- **Stage 2 — Strict LLM grouping** (`_synthesise_headlines`): Runs on the already-reduced set. The prompt was rewritten with strict constraints — only group the *identical* event (same actors, same outcome, same day); explicitly forbids thematic grouping; instructs the model to copy the best existing headline rather than synthesise a new one.

`_SYNTHESIS_ON` re-enabled. The background task logs the Stage 1 reduction count (e.g. `80 → 42 headlines`) for observability.