# S.T.A.R.L.I.N.G. — Planned Enhancements

All implementation plans live in [`plan/`](./plan/). Completed feature guides have been archived to [`assets/archived/`](./assets/archived/).

> Status legend: ✅ Done · 🟡 Core complete · 🔲 Planned

---

## Social & Content Feeds

| Feature | Plan | Status | Description |
|---|---|---|---|
| Reddit Feed | [`assets/archived/feature-reddit-social-1.md`](./assets/archived/feature-reddit-social-1.md) | 🟡 Core complete | Voice-triggered panel fetching top posts from configurable subreddits via the Reddit JSON API; LLM synthesis; filter by subreddit and sort; expandable panel layout |
| Reddit Auth (personalised) | [`plan/feature-reddit-account-discovery-1.md`](./plan/feature-reddit-account-discovery-1.md) | 🔲 Planned | PRAW account sync, keyword subreddit search, and bulk paste import for the Reddit Settings view — read your personal frontpage, saved, and upvoted content |
| YouTube Feed | [`assets/archived/feature-youtube-feed-1.md`](./assets/archived/feature-youtube-feed-1.md) | 🟡 Core complete | Voice-triggered panel fetching latest videos from subscribed/default channels via YouTube RSS; LLM synthesis; filter by channel and sort; expandable tile panel |
| YouTube Auth (personalised) | [`plan/feature-youtube-channel-discovery-1.md`](./plan/feature-youtube-channel-discovery-1.md) | 🔲 Planned | Handle/URL channel resolution, Google OAuth subscription sync, and keyword channel search for the YouTube Settings view |
| Research Papers | [`plan/feature-research-papers-1.md`](./plan/feature-research-papers-1.md) | 🔲 Planned | Voice-driven research tool querying the free, key-less arXiv and Semantic Scholar APIs for spoken paper briefings |

---

## Voice Tools & Integrations

| Feature | Plan | Status | Description |
|---|---|---|---|
| Toolkit Menu | [`assets/archived/feature-toolkit-menu-1.md`](./assets/archived/feature-toolkit-menu-1.md) | ✅ Done | Voice- and button-triggered overlay panel listing every active Starling tool; click any tool for a spoken LLM briefing, then confirm by voice or click to activate it directly |
| Tool Awareness & Fuzzy Recovery | [`assets/archived/feature-tool-awareness-1.md`](./assets/archived/feature-tool-awareness-1.md) | ✅ Done | Injects a structured tool manifest into the system prompt so Starling can describe her own capabilities; fuzzy-intent layer at the tail of the intercept chain catches near-miss transcripts and asks for confirmation before opening a tool |
| System Awareness | [`assets/archived/feature-system-awareness-1.md`](./assets/archived/feature-system-awareness-1.md) | ✅ Done | Single-source runtime introspection: boot snapshot, tool inventory, last-event metrics, live process/GPU telemetry, and a deterministic static prompt block injected into every LLM call; voice trigger + SYSTEM STATUS panel + localhost-only endpoints |
| iCloud Calendar | [`assets/archived/complete/CALENDAR.md`](./assets/archived/complete/CALENDAR.md) | ✅ Done | CalDAV calendar panel sourced from iCloud; today's and the coming week's events; Apple ID + App-Specific Password auth; 1-hour disk cache |
| Apple Mail Inbox | [`assets/archived/feature-apple-mail-inbox-1.md`](./assets/archived/feature-apple-mail-inbox-1.md) | ✅ Done | IMAP inbox panel showing recent unread messages (headers only, never body content); Apple ID + App-Specific Password auth; 5-minute in-memory cache |
| RAG Memory Manager | [`plan/feature-rag-memory-manager-1.md`](./plan/feature-rag-memory-manager-1.md) | 🔲 Planned | Voice-triggered panel to upload `.txt`/`.md` files into ChromaDB, view all ingested sources, preview chunks per document, and delete sources by name |
| Wake Word & Interrupt | [`plan/feature-wake-word-1.md`](./plan/feature-wake-word-1.md) | 🔲 Planned | "Hey Starling" always-on listener triggers the mic without a button press; speaking while Starling is talking immediately stops playback and starts listening |
| Pi-hole DNS | [`plan/feature-pihole-1.md`](./plan/feature-pihole-1.md) | 🔲 Planned | Voice-driven Pi-hole tool reporting DNS ad-blocking stats ("how many queries blocked today?") that can temporarily disable blocking on command |
| Commute & Directions | [`plan/feature-commute-directions-1.md`](./plan/feature-commute-directions-1.md) | 🔲 Planned | Drive-time / commute tool using the free, self-hostable OpenRouteService directions API — "how long to drive to <place> right now?" |
| Jellyfin Media | [`plan/feature-jellyfin-media-1.md`](./plan/feature-jellyfin-media-1.md) | 🔲 Planned | Voice-driven Jellyfin tool to browse a local media library, ask "what new movies do I have?", and control playback on a Jellyfin client |
| Local Network | [`plan/feature-local-network-1.md`](./plan/feature-local-network-1.md) | 🔲 Planned | Queries a UniFi or OPNsense router to report who/what is connected, whether a device is home (presence), and bandwidth |
| Apple Home Control | [`plan/feature-apple-home-control-1.md`](./plan/feature-apple-home-control-1.md) | 🔲 Planned | Control Apple Home (HomeKit) devices via a Home Assistant REST bridge |
| Things 3 Tasks | [`plan/feature-things3-tasks-1.md`](./plan/feature-things3-tasks-1.md) | 🔲 Planned | Voice-driven Things 3 task management — adding to-dos via the `things:///` URL scheme and reading lists via AppleScript on the Mac Mini |
| Voice Shortcuts (Macros) | [`plan/feature-voice-shortcuts-macros-1.md`](./plan/feature-voice-shortcuts-macros-1.md) | 🔲 Planned | User-definable voice macros that expand a custom trigger phrase into a sequenced multi-step tool action |
| Apple Health | [`plan/feature-apple-health-1.md`](./plan/feature-apple-health-1.md) | 🔲 Planned | Apple HealthKit ingestion via a macOS Shortcuts bridge — sleep, steps, and heart-rate surfaced in a spoken morning briefing |
| Siri Shortcuts Bridge | [`plan/feature-siri-shortcuts-bridge-1.md`](./plan/feature-siri-shortcuts-bridge-1.md) | 🔲 Planned | macOS Siri Shortcuts / Automator bridge to trigger Starling from iPhone, Apple Watch, or Mac without a wake word |

---

## Notifications & Presence

| Feature | Plan | Status | Description |
|---|---|---|---|
| Push Notifications (ntfy) | [`plan/feature-push-notifications-ntfy-1.md`](./plan/feature-push-notifications-ntfy-1.md) | 🔲 Planned | Free, self-hostable ntfy.sh push-notification channel so alerts can be pushed to the user's phone as one-way messages |
| Proactive Notifications | [`plan/feature-proactive-notifications-1.md`](./plan/feature-proactive-notifications-1.md) | 🔲 Planned | Presence-aware proactive scheduler that interrupts with spoken alerts (calendar, deliveries, stock targets) only when the user is home |
| Presence-Aware Wake Word | [`plan/feature-presence-aware-wake-word-1.md`](./plan/feature-presence-aware-wake-word-1.md) | 🔲 Planned | Offline wake-word daemon that only activates when the user is verified to be home |

---

## UX & Animation

| Feature | Plan | Status | Description |
|---|---|---|---|
| Boot & Shutdown Animation | [`assets/archived/feature-boot-shutdown-animation-1.md`](./assets/archived/feature-boot-shutdown-animation-1.md) | ✅ Done | Animated sphere sequence on startup and shutdown; in-UI power control buttons with visual boot/shutdown state transitions |
| Sleep Mode | [`assets/archived/feature-sleep-mode-1.md`](./assets/archived/feature-sleep-mode-1.md) | ✅ Done | Inactivity-triggered sphere retreat animation; transitions into dream state processing on sleep; wake greeting plays when the user returns |
| Cinematic Lifecycle Animations | [`assets/archived/feature-lifecycle-animations-2.md`](./assets/archived/feature-lifecycle-animations-2.md) | ✅ Done | Replaces the flat camera-zoom boot/shutdown/sleep/wake sequences with screen-filling choreography — the sphere drifts, tilts, and parallaxes through space while the orbs keep orbiting throughout |
| Sphere Surface Effects | [`assets/archived/feature-sphere-voronoi-surface-1.md`](./assets/archived/feature-sphere-voronoi-surface-1.md) | ✅ Done | User-selectable sphere surface from the menu: Voronoi bioluminescent skin (state-reactive glowing cells) or a Liquid Metal mercury shader (pole ripples + audio reactivity) |
| Orb Behaviour | [`assets/archived/feature-sphere-orb-behavior-1.md`](./assets/archived/feature-sphere-orb-behavior-1.md) | ✅ Done | Emergent, emotionally expressive boid-like behaviour for the seven orbiting orbs with state-driven colour temperature |
| Breath & Ripple | [`plan/feature-sphere-breath-ripple-1.md`](./plan/feature-sphere-breath-ripple-1.md) | 🔲 Planned | Always-on breath cycle and directional mic-impact ripple across the living sphere surface |
| Ambient FX | [`assets/archived/feature-sphere-ambient-fx-1.md`](./assets/archived/feature-sphere-ambient-fx-1.md) | ✅ Done | State-reactive atmospheric glow around the sphere and a slow procedural nebula background |
| Idle Expressiveness | [`assets/feature-sphere-idle-expressiveness-1.md`](./assets/feature-sphere-idle-expressiveness-1.md) | ✅ Done | Unpredictable idle micro-animations and an abstract full-sphere "blink" |

---

## Identity & Memory

| Feature | Plan | Status | Description |
|---|---|---|---|
| Dream State Shutdown Pipeline | [`assets/archived/feature-dream-state-shutdown-pipeline-1.md`](./assets/archived/feature-dream-state-shutdown-pipeline-1.md) | ✅ Done | On shutdown, the LLM silently processes the session transcript to extract memories, reflections, and personality updates; output written to the soul file |
| Starling Soul & Personality File | [`assets/archived/feature-starling-soul-personality-1.md`](./assets/archived/feature-starling-soul-personality-1.md) | ✅ Done | Persistent personality file that evolves session-to-session via dream state processing; injected into the system prompt at startup to give Starling continuity across sessions |
| Centralised Prompt Registry | [`assets/archived/feature-prompt-registry-1.md`](./assets/archived/feature-prompt-registry-1.md) | ✅ Done | Single source of truth for all system prompts and tool-context injections; live UI editor to modify, preview, and save prompt templates without restarting the backend |
| Episodic Memory | [`plan/feature-episodic-memory-1.md`](./plan/feature-episodic-memory-1.md) | 🔲 Planned | Extends RAG to automatically index the voice journal and conversation history into a temporally-aware episodic memory for natural long-term recall |

---

## Infrastructure & Packaging

| Feature | Plan | Status | Description |
|---|---|---|---|
| Electron Desktop App | [`plan/feature-electron-packaging-1.md`](./plan/feature-electron-packaging-1.md) | 🔲 Planned | Standalone installer for Windows, macOS, and Linux; bundles Python runtime, llama-server, and all dependencies — no prerequisites required from the user |
| Cross-Platform Auto-Detect | [`plan/feature-cross-platform-auto-detect-1.md`](./plan/feature-cross-platform-auto-detect-1.md) | 🔲 Planned | Hardware auto-detection at launch; selects CUDA, DirectML, Metal, or CPU inference paths; auto-installs the correct onnxruntime variant and recommends the right model size for available VRAM |
| macOS Apple Silicon (M4) | [`plan/feature-mac-m4-compatibility-1.md`](./plan/feature-mac-m4-compatibility-1.md) | 🔲 Planned | Full compatibility with Apple Silicon Macs (M4 Mac Mini target); Metal GPU acceleration for Whisper and Kokoro; llama-server Metal backend; unified memory VRAM detection |
| Watchdog Supervisor | [`plan/feature-watchdog-process-1.md`](./plan/feature-watchdog-process-1.md) | 🔲 Planned | Keeps the backend running 24/7 on the Mac Mini, auto-restarting it (and llama-server) on crash via launchd |
| Local Admin Dashboard | [`plan/feature-local-admin-dashboard-1.md`](./plan/feature-local-admin-dashboard-1.md) | 🔲 Planned | Lightweight local admin dashboard showing live uptime, memory/CPU usage, the last conversation, and active tools for remote debugging of the 24/7 deployment |
