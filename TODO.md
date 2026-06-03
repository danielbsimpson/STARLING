# S.T.A.R.L.I.N.G. — Planned Enhancements

Feature notes are listed inline below (paths shown as plain text, not links).

> Status legend: ✅ Done · 🟡 Core complete · 🔲 Planned

---

## Social & Content Feeds

| Feature | Plan | Status | Description |
|---|---|---|---|
| Reddit Feed | `Internal archive note` | 🟡 Core complete | Voice-triggered panel fetching top posts from configurable subreddits via the Reddit JSON API; LLM synthesis; filter by subreddit and sort; expandable panel layout |
| Reddit Auth (personalised) | `Internal spec` | 🔲 Planned | PRAW account sync, keyword subreddit search, and bulk paste import for the Reddit Settings view — read your personal frontpage, saved, and upvoted content |
| YouTube Feed | `Internal archive note` | 🟡 Core complete | Voice-triggered panel fetching latest videos from subscribed/default channels via YouTube RSS; LLM synthesis; filter by channel and sort; expandable tile panel |
| YouTube Auth (personalised) | `Internal spec` | 🔲 Planned | Handle/URL channel resolution, Google OAuth subscription sync, and keyword channel search for the YouTube Settings view |
| Research Papers | `Internal archive note` | ✅ Done | Voice-driven research tool querying free, key-less arXiv and Semantic Scholar APIs for spoken paper briefings with recency windows and de-duplicated cross-source results |

---

## Voice Tools & Integrations

| Feature | Plan | Status | Description |
|---|---|---|---|
| Toolkit Menu | `Internal archive note` | ✅ Done | Voice- and button-triggered overlay panel listing every active Starling tool; click any tool for a spoken LLM briefing, then confirm by voice or click to activate it directly |
| Tool Awareness & Fuzzy Recovery | `Internal archive note` | ✅ Done | Injects a structured tool manifest into the system prompt so Starling can describe her own capabilities; fuzzy-intent layer at the tail of the intercept chain catches near-miss transcripts and asks for confirmation before opening a tool |
| System Awareness | `Internal archive note` | ✅ Done | Single-source runtime introspection: boot snapshot, tool inventory, last-event metrics, live process/GPU telemetry, and a deterministic static prompt block injected into every LLM call; voice trigger + SYSTEM STATUS panel + localhost-only endpoints |
| iCloud Calendar | `Internal archive note` | ✅ Done | CalDAV calendar panel sourced from iCloud; today's and the coming week's events; Apple ID + App-Specific Password auth; 1-hour disk cache |
| Apple Mail Inbox | `Internal archive note` | ✅ Done | IMAP inbox panel showing recent unread messages (headers only, never body content); Apple ID + App-Specific Password auth; 5-minute in-memory cache |
| RAG Memory Manager | `Internal spec` | 🔲 Planned | Voice-triggered panel to upload `.txt`/`.md` files into ChromaDB, view all ingested sources, preview chunks per document, and delete sources by name |
| Wake Word & Interrupt | `Internal spec` | 🔲 Planned | "Hey Starling" always-on listener triggers the mic without a button press; speaking while Starling is talking immediately stops playback and starts listening |
| Pi-hole DNS | `Internal spec` | 🔲 Planned | Voice-driven Pi-hole tool reporting DNS ad-blocking stats ("how many queries blocked today?") that can temporarily disable blocking on command |
| Commute & Directions | `Internal archive note` | ✅ Done | Drive-time / commute tool using OpenRouteService with route-map rendering, travel-mode inference (drive/walk/bike), and spoken ETA-distance briefings |
| Jellyfin Media | `Internal spec` | 🔲 Planned | Voice-driven Jellyfin tool to browse a local media library, ask "what new movies do I have?", and control playback on a Jellyfin client |
| Local Network | `Internal spec` | 🔲 Planned | Queries a UniFi or OPNsense router to report who/what is connected, whether a device is home (presence), and bandwidth |
| Apple Home Control | `Internal spec` | 🔲 Planned | Control Apple Home (HomeKit) devices via a Home Assistant REST bridge |
| Things 3 Tasks | `Internal spec` | 🔲 Planned | Voice-driven Things 3 task management — adding to-dos via the `things:///` URL scheme and reading lists via AppleScript on the Mac Mini |
| Voice Shortcuts (Macros) | `Internal spec` | 🔲 Planned | User-definable voice macros that expand a custom trigger phrase into a sequenced multi-step tool action |
| Apple Health | `Internal spec` | 🔲 Planned | Apple HealthKit ingestion via a macOS Shortcuts bridge — sleep, steps, and heart-rate surfaced in a spoken morning briefing |
| Siri Shortcuts Bridge | `Internal spec` | 🔲 Planned | macOS Siri Shortcuts / Automator bridge to trigger Starling from iPhone, Apple Watch, or Mac without a wake word |

---

## Notifications & Presence

| Feature | Plan | Status | Description |
|---|---|---|---|
| Push Notifications (ntfy) | `Internal spec` | 🔲 Planned | Free, self-hostable ntfy.sh push-notification channel so alerts can be pushed to the user's phone as one-way messages |
| Proactive Notifications | `Internal spec` | 🔲 Planned | Presence-aware proactive scheduler that interrupts with spoken alerts (calendar, deliveries, stock targets) only when the user is home |
| Presence-Aware Wake Word | `Internal spec` | 🔲 Planned | Offline wake-word daemon that only activates when the user is verified to be home |

---

## UX & Animation

| Feature | Plan | Status | Description |
|---|---|---|---|
| Boot & Shutdown Animation | `Internal archive note` | ✅ Done | Animated sphere sequence on startup and shutdown; in-UI power control buttons with visual boot/shutdown state transitions |
| Sleep Mode | `Internal archive note` | ✅ Done | Inactivity-triggered sphere retreat animation; transitions into dream state processing on sleep; wake greeting plays when the user returns |
| Cinematic Lifecycle Animations | `Internal archive note` | ✅ Done | Replaces the flat camera-zoom boot/shutdown/sleep/wake sequences with screen-filling choreography — the sphere drifts, tilts, and parallaxes through space while the orbs keep orbiting throughout |
| Sphere Surface Effects | `Internal archive note` | ✅ Done | User-selectable sphere surface from the menu: Voronoi bioluminescent skin (state-reactive glowing cells) or a Liquid Metal mercury shader (pole ripples + audio reactivity) |
| Orb Behaviour | `Internal archive note` | ✅ Done | Emergent, emotionally expressive boid-like behaviour for the seven orbiting orbs with state-driven colour temperature |
| Breath & Ripple | `Internal spec` | ✅ Done| Always-on breath cycle and directional mic-impact ripple across the living sphere surface |
| Ambient FX | `Internal archive note` | ✅ Done | State-reactive atmospheric glow around the sphere and a slow procedural nebula background |
| Idle Expressiveness | `Internal archive note` | ✅ Done | Unpredictable idle micro-animations and an abstract full-sphere "blink" |

---

## Identity & Memory

| Feature | Plan | Status | Description |
|---|---|---|---|
| Dream State Shutdown Pipeline | `Internal archive note` | ✅ Done | On shutdown, the LLM silently processes the session transcript to extract memories, reflections, and personality updates; output written to the soul file |
| Starling Soul & Personality File | `Internal archive note` | ✅ Done | Persistent personality file that evolves session-to-session via dream state processing; injected into the system prompt at startup to give Starling continuity across sessions |
| Centralised Prompt Registry | `Internal archive note` | ✅ Done | Single source of truth for all system prompts and tool-context injections; live UI editor to modify, preview, and save prompt templates without restarting the backend |
| Episodic Memory | `Internal spec` | 🔲 Planned | Extends RAG to automatically index the voice journal and conversation history into a temporally-aware episodic memory for natural long-term recall |

---

## Infrastructure & Packaging

| Feature | Plan | Status | Description |
|---|---|---|---|
| Electron Desktop App | `Internal spec` | 🔲 Planned | Standalone installer for Windows, macOS, and Linux; bundles Python runtime, llama-server, and all dependencies — no prerequisites required from the user |
| Cross-Platform Auto-Detect | `Internal spec` | 🔲 Planned | Hardware auto-detection at launch; selects CUDA, DirectML, Metal, or CPU inference paths; auto-installs the correct onnxruntime variant and recommends the right model size for available VRAM |
| macOS Apple Silicon (M4) | `Internal spec` | 🔲 Planned | Full compatibility with Apple Silicon Macs (M4 Mac Mini target); Metal GPU acceleration for Whisper and Kokoro; llama-server Metal backend; unified memory VRAM detection |
| Watchdog Supervisor | `Internal spec` | 🔲 Planned | Keeps the backend running 24/7 on the Mac Mini, auto-restarting it (and llama-server) on crash via launchd |
| Local Admin Dashboard | `Internal spec` | 🔲 Planned | Lightweight local admin dashboard showing live uptime, memory/CPU usage, the last conversation, and active tools for remote debugging of the 24/7 deployment |


