# S.T.A.R.L.I.N.G. — Planned Enhancements

All implementation plans live in [`plan/`](./plan/). Completed feature guides have been archived to [`assets/archived/`](./assets/archived/).

---

## Social & Content Feeds

| Feature | Plan | Status | Description |
|---|---|---|---|
| Reddit Feed | [`assets/archived/feature-reddit-social-1.md`](./assets/archived/feature-reddit-social-1.md) | ✅ Core complete | Voice-triggered panel fetching top posts from configurable subreddits via the Reddit JSON API; LLM synthesis; filter by subreddit and sort; expandable panel layout |
| Reddit Auth (personalised) | [`plan/feature-reddit-account-discovery-1.md`](./plan/feature-reddit-account-discovery-1.md) | 🔲 Pending | OAuth2 login to Reddit so Starling can read your personal frontpage, saved posts, and upvoted content rather than fixed public subreddits |
| YouTube Feed | [`assets/archived/feature-youtube-feed-1.md`](./assets/archived/feature-youtube-feed-1.md) | ✅ Core complete | Voice-triggered panel fetching latest videos from subscribed/default channels via YouTube RSS; LLM synthesis; filter by channel and sort; expandable tile panel |
| YouTube Auth (personalised) | [`plan/feature-youtube-channel-discovery-1.md`](./plan/feature-youtube-channel-discovery-1.md) | 🔲 Pending | OAuth2 / YouTube Data API v3 login so Starling can pull your actual subscriptions feed instead of hardcoded default channels |

---

## Voice Tools

| Feature | Plan | Status | Description |
|---|---|---|---|
| Toolkit Menu | [`plan/feature-toolkit-menu-1.md`](./plan/feature-toolkit-menu-1.md) | ✅ Done | Voice- and button-triggered overlay panel listing every active Starling tool; click any tool for a spoken LLM briefing, then confirm by voice or click to activate it directly |
| RAG Memory Manager | [`plan/feature-rag-memory-manager-1.md`](./plan/feature-rag-memory-manager-1.md) | 🔲 Pending | Voice-triggered panel to upload `.txt`/`.md` files into ChromaDB, view all ingested sources, preview chunks per document, and delete sources by name |
| Wake Word & Interrupt | [`plan/feature-wake-word-1.md`](./plan/feature-wake-word-1.md) | 🔲 Pending | "Hey Starling" always-on listener triggers the mic without a button press; speaking while Starling is talking immediately stops playback and starts listening |
| iCloud Calendar | [`assets/archived/complete/CALENDAR.md`](./assets/archived/complete/CALENDAR.md) | ✅ Done | CalDAV calendar panel sourced from iCloud; today's and the coming week's events; Apple ID + App-Specific Password auth; 1-hour disk cache |
| Apple Mail Inbox | [`assets/archived/feature-apple-mail-inbox-1.md`](./assets/archived/feature-apple-mail-inbox-1.md) | ✅ Done | IMAP inbox panel showing recent unread messages (headers only, never body content); Apple ID + App-Specific Password auth; 5-minute in-memory cache |
| Tool Awareness & Fuzzy Recovery | [`plan/feature-tool-awareness-1.md`](./plan/feature-tool-awareness-1.md) | 🔲 Pending | Injects a structured tool manifest into the system prompt so Starling can describe her own capabilities; fuzzy-intent layer at the tail of the intercept chain catches near-miss transcripts and asks for confirmation before opening a tool |
| System Awareness | [`plan/feature-system-awareness-1.md`](./plan/feature-system-awareness-1.md) | ✅ Done | Single-source runtime introspection: boot snapshot, tool inventory, last-event metrics, live process/GPU telemetry, and a deterministic static prompt block injected into every LLM call. Voice trigger ("system status") + SYSTEM STATUS panel + localhost-only `/system/status`, `/system/health`, `/system/refresh-tools` endpoints. |

---

## UX & Animation

| Feature | Plan | Description |
|---|---|---|
| Boot & Shutdown Animation | [`plan/feature-boot-shutdown-animation-1.md`](./plan/feature-boot-shutdown-animation-1.md) | Animated sphere sequence on startup and shutdown; in-UI power control buttons with visual boot/shutdown state transitions |
| Sleep Mode | [`plan/feature-sleep-mode-1.md`](./plan/feature-sleep-mode-1.md) | Inactivity-triggered sphere retreat animation; transitions into dream state processing on sleep; wake greeting plays when the user returns |

---

## Identity & Memory

| Feature | Plan | Description |
|---|---|---|
| Dream State Shutdown Pipeline | [`plan/feature-dream-state-shutdown-pipeline-1.md`](./plan/feature-dream-state-shutdown-pipeline-1.md) | On shutdown, the LLM silently processes the session transcript to extract memories, reflections, and personality updates; output written to the soul file |
| Starling Soul & Personality File | [`plan/feature-starling-soul-personality-1.md`](./plan/feature-starling-soul-personality-1.md) | Persistent personality file that evolves session-to-session via dream state processing; injected into the system prompt at startup to give Starling continuity across sessions |
| Centralised Prompt Registry | [`plan/feature-prompt-registry-1.md`](./plan/feature-prompt-registry-1.md) | Single source of truth for all system prompts and tool-context injections; live UI editor to modify, preview, and save prompt templates without restarting the backend |

---

## Infrastructure & Packaging

| Feature | Plan | Description |
|---|---|---|
| Electron Desktop App | [`plan/feature-electron-packaging-1.md`](./plan/feature-electron-packaging-1.md) | Standalone installer for Windows, macOS, and Linux; bundles Python runtime, llama-server, and all dependencies — no prerequisites required from the user |
| Cross-Platform Auto-Detect | [`plan/feature-cross-platform-auto-detect-1.md`](./plan/feature-cross-platform-auto-detect-1.md) | Hardware auto-detection at launch; selects CUDA, DirectML, Metal, or CPU inference paths; auto-installs the correct onnxruntime variant and recommends the right model size for available VRAM |
| macOS Apple Silicon (M4) | [`plan/feature-mac-m4-compatibility-1.md`](./plan/feature-mac-m4-compatibility-1.md) | Full compatibility with Apple Silicon Macs (M4 Mac Mini target); Metal GPU acceleration for Whisper and Kokoro; llama-server Metal backend; unified memory VRAM detection |
