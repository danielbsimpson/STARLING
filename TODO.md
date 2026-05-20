# S.T.A.R.L.I.N.G. — Planned Enhancements

All implementation plans live in [`plan/`](./plan/). Completed feature guides have been archived to [`assets/archived/`](./assets/archived/).

---

## Voice Tools

| Feature | Plan | Description |
|---|---|---|
| Wake Word & Interrupt | [`plan/WAKE_WORD.md`](./plan/WAKE_WORD.md) | "Hey Starling" always-on listener triggers the mic without a button press; speaking while Starling is talking immediately stops playback and starts listening |
| Google Calendar | [`plan/CALENDAR.md`](./plan/CALENDAR.md) | Voice-triggered calendar panel; reads Google Calendar via OAuth2; daily and weekly event views; LLM spoken briefing ("what's on my schedule today?") |
| Gmail | [`plan/GMAIL.md`](./plan/GMAIL.md) | Voice-triggered inbox panel; fetches unread messages via Gmail API; spoken summary ("you have 5 unread emails from…"); open any message for a full-text LLM summary |
| Tool Awareness & Fuzzy Recovery | [`plan/TOOL_AWARENESS.md`](./plan/TOOL_AWARENESS.md) | Injects a structured tool manifest into the system prompt so Starling can describe her own capabilities; fuzzy-intent layer at the tail of the intercept chain catches near-miss transcripts and asks for confirmation before opening a tool |

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
