---
goal: Sleep Mode — Inactivity-Triggered Sphere Retreat, Dream State, and Wake Greeting
version: '1.0'
date_created: 2026-05-20
last_updated: 2026-05-20
owner: simps
status: 'Planned'
tags: [feature, frontend, animation, ux, three.js, dream-state, inactivity, power-management]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

When the user has not interacted with S.T.A.R.L.I.N.G. for a configurable period of inactivity, the system enters **sleep mode**: the sphere and orbiting light orbs perform a retreat animation identical in style to the shutdown sequence — slowly drifting back into space, oscillating, then curving off-screen. The UI controls and frame elements fade out, leaving a near-black screen with a subtle sleeping indicator. The system does **not** shut down; the backend stays alive.

Immediately after the sphere disappears, a **dream state** is triggered — `dream.run_dream_state()` processes all new session activity since the last dream checkpoint, so the LLM can summarize, extract facts, and reflect while the user is away. A **checkpoint timestamp** is stored after each dream run so that repeated sleep events within a single session each process only the new activity since the previous dream, with no duplicate summarization.

When the user interacts (any click, keypress, or mic button press), a **wake animation** plays: the sphere re-emerges from deep space, travelling from far away back to its default position with a decreasing lateral oscillation. Once the animation settles, Starling greets the user with a contextual voice + text message acknowledging the return.

## 1. Requirements & Constraints

- **REQ-001**: The sleep mode must be triggered automatically after `SLEEP_AFTER_MS` milliseconds of user inactivity. "Inactivity" is defined as no mic button press, no text input keypress, and no send button click.
- **REQ-002**: The sleep animation must reuse the same camera retreat path as the shutdown animation defined in `feature-boot-shutdown-animation-1.md` (camera `z: 6.2 → 80`, lateral oscillation, final off-screen curve) but is governed by its own `SLEEP_ANIMATION_MS` duration constant.
- **REQ-003**: After the sphere completes the retreat animation, `POST /dream/run` must be called with the current `session_id` and a `from_ts` parameter containing the ISO 8601 UTC timestamp of the last dream checkpoint (or session start if no checkpoint exists). The dream state must only process events with `ts >= from_ts`.
- **REQ-004**: After each dream run completes, the checkpoint timestamp must be persisted to `backend/memory/dream/checkpoint.json` as `{"session_id": "<id>", "last_dream_at": "<ISO 8601 UTC>"}`. This file is overwritten on each dream run. On system shutdown, the dream state must read this file and use `last_dream_at` as its `from_ts` to avoid re-summarizing already-processed events.
- **REQ-005**: The wake animation must reuse the camera approach path from the boot animation in `feature-boot-shutdown-animation-1.md` (camera `z: 80 → 6.2`, decreasing lateral oscillation, ease-out-cubic easing) governed by its own `WAKE_ANIMATION_MS` duration constant.
- **REQ-006**: Upon completion of the wake animation, Starling must automatically send a contextual wake greeting to the LLM and speak the response. The greeting prompt must reference the time elapsed since the user was last active.
- **REQ-007**: All UI controls (mic button, text input, send button, power button) must be non-interactive while the sleep animation is playing and while in sleep state. They must re-enable once the wake animation completes.
- **REQ-008**: `SLEEP_AFTER_MS`, `SLEEP_ANIMATION_MS`, and `WAKE_ANIMATION_MS` must be exported constants in `frontend/config.js`. They must be the single-source-of-truth for all timing.
- **REQ-009**: The inactivity timer must reset on any wake event (click, keypress, mic press) and must not fire again until the full `SLEEP_AFTER_MS` of inactivity elapses again.
- **REQ-010**: Sleep mode must be compatible with the animation phase guard (`_sphereAnimPhase !== 'none'`) introduced in `feature-boot-shutdown-animation-1.md`. The inactivity timer must not trigger sleep if an animation is currently playing.
- **DRM-001**: The dream state called on sleep must be non-blocking from the frontend's perspective — the frontend fires-and-forgets `POST /dream/run` and does not wait for it to complete before displaying the sleep overlay.
- **DRM-002**: A `from_ts` parameter must be added to `POST /dream/run` request body and propagated to `build_transcript()` in `backend/dream.py` so that only events after the checkpoint are included in the transcript.
- **DRM-003**: On system shutdown (via `POST /system/shutdown` from `feature-boot-shutdown-animation-1.md` or `make down` from the launcher plan), the FastAPI shutdown handler must read `checkpoint.json` and pass `last_dream_at` as `from_ts` to `run_dream_state()`, ensuring the final dream state covers only events since the last sleep dream.
- **SEC-001**: `POST /dream/run` already requires localhost origin (defined in `feature-dream-state-shutdown-pipeline-1.md`). No additional security requirements.
- **CON-001**: The backend process must not be terminated during sleep mode. Sleep is a purely visual/UI state change with a background dream run.
- **CON-002**: No new Python packages may be introduced. Checkpoint file I/O uses only `json` and `pathlib` (stdlib).
- **CON-003**: The sleep animation must not conflict with or interrupt any pending audio playback. If Starling is currently speaking (`sphereStateRef.current === 'speaking'`), the inactivity timer must not fire until speaking completes.
- **GUD-001**: The sleep overlay must be visually distinct from the shutdown offline overlay. Use a dimmed, breathing (pulsing opacity) "SLEEPING" label rather than a static "OFFLINE" label.
- **GUD-002**: The wake greeting prompt must be injected as a `system`-role message in the conversation history so it does not appear as a user turn in the chat panel — only the assistant's greeting response appears.
- **PAT-001**: Follow the animation phase variable pattern from `feature-boot-shutdown-animation-1.md`: use `_sphereAnimPhase` to track `'sleeping' | 'waking' | 'none'` states and guard against conflicting triggers.
- **PAT-002**: Follow the existing activity-detection pattern: track `_lastActivityTs = Date.now()` updated at every user input event, checked by a `setInterval` poll.

## 2. Implementation Steps

### Implementation Phase 1 — Configuration Constants

- GOAL-001: Add sleep/wake timing constants to `frontend/config.js` so all durations are tunable from a single location.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `frontend/config.js`, add `export const SLEEP_AFTER_MS = 600000;` (10 minutes). Add `export const SLEEP_ANIMATION_MS = 4000;` (4 seconds). Add `export const WAKE_ANIMATION_MS = 5000;` (5 seconds). Add comment: `// Increase SLEEP_AFTER_MS to delay sleep trigger. Adjust animation durations to match observed dream state run time.` | | |
| TASK-002 | In `frontend/app.js`, import `SLEEP_AFTER_MS`, `SLEEP_ANIMATION_MS`, `WAKE_ANIMATION_MS` from `./config.js` alongside the existing imports. | | |

### Implementation Phase 2 — Inactivity Tracker

- GOAL-002: Implement a frontend inactivity detector that tracks the last user interaction timestamp and fires `enterSleepMode()` after the configured idle period.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | In `frontend/app.js`, declare `let _lastActivityTs = Date.now()` at module scope. Define `function _resetActivity() { _lastActivityTs = Date.now(); }`. | | |
| TASK-004 | Call `_resetActivity()` inside: the `handleSend()` function (before `await _routeInput(text)`), the mic button `click` event handler (at the top of the handler, before recording starts), and the `mediaRecorder.onstop` handler (after transcript is received and before `_routeInput`). | | |
| TASK-005 | After all event listeners are registered (at the bottom of `app.js`), start the inactivity polling loop: `setInterval(() => { if (_sphereAnimPhase !== 'none') return; if (sphereStateRef.current === 'speaking' || sphereStateRef.current === 'listening') return; if (_isSleeping) return; if (Date.now() - _lastActivityTs >= SLEEP_AFTER_MS) enterSleepMode(); }, 15000);` (checks every 15 seconds). Declare `let _isSleeping = false` at module scope. | | |

### Implementation Phase 3 — Sleep Animation

- GOAL-003: Implement `enterSleepMode()` in `app.js` — disables controls, sets the animation phase to `'sleeping'`, and executes the sphere retreat animation inside the Three.js RAF loop.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | In `frontend/app.js`, define `function enterSleepMode()`. It must: (1) set `_isSleeping = true`; (2) disable mic button, send button, text input, and power button (set `disabled` attribute); (3) call `setState('idle')` to neutralise orb colours; (4) set `_animPhase = 'sleeping'` and `_animStart = Date.now()` via the setter functions introduced in `feature-boot-shutdown-animation-1.md`; (5) record `_sleepEnteredAt = Date.now()` for use in the wake greeting. | | |
| TASK-007 | In the `animate()` RAF loop inside `initSphere()`, add a `'sleeping'` animation block. When `_animPhase === 'sleeping'`: compute `const p = Math.min((Date.now() - _animStart) / SLEEP_ANIMATION_MS, 1)`. Apply ease-in-quad: `const eased = p * p`. Set `camera.position.z = 6.2 + (80 - 6.2) * eased`. Oscillation: `camera.position.x = 2.4 * Math.sin(p * Math.PI * 5)`. Final off-screen curve (last 25%): when `p > 0.75`, add `((p - 0.75) / 0.25) * 18` to `camera.position.x` and set `camera.position.y = ((p - 0.75) / 0.25) * 10`. When `p >= 1`, set `_animPhase = 'none'` and call `_onSleepAnimationComplete()`. | | |
| TASK-008 | Define `_onSleepAnimationComplete()` in `app.js`. It must: (1) show the sleep overlay (`#sleep-overlay`, see TASK-013) by adding class `visible`; (2) call `_triggerSleepDream()` (defined in Phase 5). | | |

### Implementation Phase 4 — Sleep UI Overlay

- GOAL-004: Add a distinct sleep overlay to the UI that covers the interface during sleep state, and ensure all structural UI elements are hidden while sleeping.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-009 | In `frontend/index.html`, add the following div immediately before the closing `</div>` of `<div class="starling" id="starling">`: `<div class="sleep-overlay hidden" id="sleep-overlay"><div class="sleep-label" id="sleep-label">SLEEPING</div></div>`. | | |
| TASK-010 | In `frontend/style.css`, add `.sleep-overlay` styles: `position: absolute; inset: 0; background: rgba(6,6,6,0.97); display: flex; align-items: center; justify-content: center; z-index: 8000; opacity: 0; pointer-events: none; transition: opacity 1.5s ease`. Add `.sleep-overlay.visible`: `opacity: 1; pointer-events: all`. When the overlay becomes visible, it must capture pointer events so a click anywhere wakes the system (TASK-018). | | |
| TASK-011 | In `frontend/style.css`, add `.sleep-label` styles: `font-family: 'Share Tech Mono', monospace; font-size: 9px; letter-spacing: 5px; color: rgba(200,200,200,0.12); text-transform: uppercase; animation: sleep-breathe 4s ease-in-out infinite`. Define `@keyframes sleep-breathe { 0%, 100% { opacity: 0.08; } 50% { opacity: 0.22; } }` so the label pulses subtly, indicating a live (not dead) system. | | |
| TASK-012 | In `frontend/style.css`, add a `.starling.sleep-mode` class rule: `.starling.sleep-mode .hdr, .starling.sleep-mode .body-cols { opacity: 0; transition: opacity 0.8s ease; }`. In `enterSleepMode()` (TASK-006), add `starlingEl.classList.add('sleep-mode')` after the animation starts. In the wake sequence (`_onWakeAnimationComplete()`, TASK-023), remove the class: `starlingEl.classList.remove('sleep-mode')`. | | |
| TASK-013 | Get a reference to the sleep overlay in `app.js`: `const sleepOverlay = document.getElementById('sleep-overlay')`. This reference is used by `_onSleepAnimationComplete()` (TASK-008) and `wakeSleepMode()` (TASK-018). | | |

### Implementation Phase 5 — Dream State on Sleep

- GOAL-005: Trigger `POST /dream/run` with the current session ID and last-checkpoint timestamp immediately after the sleep animation completes, and update the checkpoint after each run.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-014 | In `frontend/app.js`, declare `let _lastDreamCheckpointTs = null` at module scope. This is updated by the backend response after a successful dream run. | | |
| TASK-015 | In `frontend/app.js`, define `async function _triggerSleepDream()`. It must: (1) build the request body: `{ session_id: session_log_get_session_id(), from_ts: _lastDreamCheckpointTs }` where `session_log_get_session_id()` is a call to `GET ${BACKEND_BASE}/health` to retrieve `current_session` (or cache it from the health response on startup); (2) call `fetch(\`${BACKEND_BASE}/dream/run\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})` fire-and-forget — do not `await`; (3) start polling `GET ${BACKEND_BASE}/dream/status` every 10 seconds until `completed_passes` is non-empty, then set `_lastDreamCheckpointTs = new Date().toISOString()` and stop polling. | | |
| TASK-016 | On `DOMContentLoaded` in `app.js`, after fetching the system status, call `GET ${BACKEND_BASE}/health` and store `data.current_session` in a module-level variable `_currentSessionId` so it is available to `_triggerSleepDream()` without an extra fetch. | | |

### Implementation Phase 6 — Backend Dream Checkpoint

- GOAL-006: Extend `backend/dream.py` and `backend/dream_routes.py` to support a `from_ts` parameter and persist a checkpoint file after each dream run, so repeated sleep events within a session do not re-process already-summarized events.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-017 | In `backend/dream.py`, modify `build_transcript(log_path: Path, from_ts: Optional[str] = None) -> str`. After parsing each JSONL line to `record`, if `from_ts` is not None: parse `record.get("ts", "")` as ISO 8601 and skip any record whose `ts` is strictly before `from_ts`. All other logic (event type mapping, truncation) is unchanged. `from_ts=None` means process all events (existing behaviour). | | |
| TASK-018 | In `backend/dream.py`, modify `run_dream_state(session_id: str, from_ts: Optional[str] = None) -> DreamResult`. Pass `from_ts` through to `build_transcript()`. After all passes complete without error, call `_write_checkpoint(session_id)`. | | |
| TASK-019 | In `backend/dream.py`, define `CHECKPOINT_PATH = DREAM_DIR / "checkpoint.json"`. Implement `def _write_checkpoint(session_id: str) -> None`. Write `{"session_id": session_id, "last_dream_at": datetime.now(timezone.utc).isoformat()}` to `CHECKPOINT_PATH` atomically (tmp → rename pattern, PAT-002 from the dream state plan). | | |
| TASK-020 | In `backend/dream.py`, implement `def read_checkpoint() -> Optional[str]`. Read `CHECKPOINT_PATH` and return `data["last_dream_at"]` as a string if the file exists and `data["session_id"]` matches the current session ID from `session_log.get_session_id()`. Return `None` if file does not exist, cannot be parsed, or belongs to a different session. | | |
| TASK-021 | In `backend/dream_routes.py`, update the `POST /dream/run` endpoint to accept an optional `from_ts: Optional[str] = None` field in the request body Pydantic model (or JSON body). Pass it through to `dream.run_dream_state(session_id, from_ts=from_ts)`. | | |
| TASK-022 | In `backend/main.py`, update the `@app.on_event("shutdown")` handler to call `from_ts = dream.read_checkpoint()` before calling `dream.run_dream_state(session_log.get_session_id(), from_ts=from_ts)`. This ensures the final shutdown dream only processes events not yet summarized by a prior sleep dream. | | |

### Implementation Phase 7 — Wake Trigger and Wake Animation

- GOAL-007: Detect wake events (click on sleep overlay, any keypress, or mic button press) while sleeping, and play the sphere approach animation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-023 | In `frontend/app.js`, define `function wakeSleepMode()`. Guard: if `!_isSleeping` or `_animPhase !== 'none'` return immediately. It must: (1) hide the sleep overlay by removing class `visible` from `#sleep-overlay`; (2) set `_animPhase = 'waking'` and `_animStart = Date.now()` via the setter; (3) set `_isSleeping = false` immediately so the inactivity timer can restart. | | |
| TASK-024 | In the `animate()` RAF loop inside `initSphere()`, add a `'waking'` animation block. When `_animPhase === 'waking'`: compute `const p = Math.min((Date.now() - _animStart) / WAKE_ANIMATION_MS, 1)`. Apply ease-out-cubic: `const eased = 1 - Math.pow(1 - p, 3)`. Set `camera.position.z = 80 + (6.2 - 80) * eased`. Oscillation with decreasing amplitude: `const amp = (1 - eased) * 2.8; camera.position.x = amp * Math.sin(p * Math.PI * 6); camera.position.y = amp * 0.45 * Math.cos(p * Math.PI * 4.7 + 0.9)`. When `p >= 1`, set `camera.position.set(0, 0, 6.2)`, `_animPhase = 'none'`, call `_onWakeAnimationComplete()`. | | |
| TASK-025 | In `frontend/app.js`, attach wake listeners: (1) `sleepOverlay.addEventListener('click', wakeSleepMode)` — clicking anywhere on the overlay wakes the system; (2) `document.addEventListener('keydown', (e) => { if (_isSleeping) { e.preventDefault(); wakeSleepMode(); } })` — any key press while sleeping triggers wake; (3) inside the mic button click handler, add `if (_isSleeping) { wakeSleepMode(); return; }` at the very top — a mic press wakes without starting recording. | | |
| TASK-026 | Define `_onWakeAnimationComplete()` in `app.js`. It must: (1) remove `sleep-mode` class from `starlingEl`; (2) re-enable mic button, send button, text input, and power button; (3) call `setState('idle')`; (4) call `_resetActivity()` to restart the inactivity timer; (5) call `_sendWakeGreeting()` (Phase 8). | | |

### Implementation Phase 8 — Wake Greeting

- GOAL-008: Automatically have Starling greet the user when waking, using the elapsed sleep time as context for a natural, personalised greeting.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-027 | In `frontend/app.js`, define `async function _sendWakeGreeting()`. Compute elapsed: `const elapsedMin = Math.round((Date.now() - _sleepEnteredAt) / 60000)`. Build a greeting injection string: `const greetingNote = elapsedMin >= 1 ? \`The user has just returned after approximately ${elapsedMin} minute${elapsedMin !== 1 ? 's' : ''} of inactivity. Greet them warmly and briefly — one or two sentences maximum. Do not refer to yourself as having been asleep.\` : \`The user has just returned. Greet them briefly.\``. | | |
| TASK-028 | In `_sendWakeGreeting()`, call `sendToOllama('', { wakeGreeting: true, systemNote: greetingNote })`. The existing `sendToOllama()` function must be extended to accept a `systemNote` option: when `opts.systemNote` is provided, prepend a `{"role": "system", "content": opts.systemNote}` message to the messages array before sending to the LLM, and remove it from the conversation history after the response (it is ephemeral, not persisted in `conversationHistory`). | | |
| TASK-029 | In `sendToOllama()` (in `frontend/app.js`), add handling for the `wakeGreeting` flag: when `opts.wakeGreeting` is true, do not call `appendMessage('user', ...)` for the empty input string. The assistant's greeting response is still appended and spoken as normal. | | |

### Implementation Phase 9 — Gitignore Update

- GOAL-009: Ensure the checkpoint file is not tracked in git.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-030 | In `.gitignore`, add `backend/memory/dream/` on a new line under the existing `backend/memory/logs/` entry added by the session logging plan. | | |

## 3. Alternatives

- **ALT-001**: **Page `visibilitychange` event instead of inactivity timer** — trigger sleep when the browser tab becomes hidden (`document.hidden === true`). Rejected because the user may have the STARLING tab visible on a secondary monitor while working elsewhere, and the system should sleep based on interaction absence, not tab focus.
- **ALT-002**: **WebSocket heartbeat from backend** — let the backend push a sleep trigger after a server-side inactivity timeout. Rejected because the current architecture has no persistent WebSocket connection; adding one solely for sleep detection is over-engineering.
- **ALT-003**: **Dim the sphere in-place rather than animate retreat** — fade the sphere to near-black without a camera animation. Rejected by the user's explicit design intent: the retreat animation is the desired visual metaphor for Starling "going to sleep."
- **ALT-004**: **Run dream state synchronously in the backend before showing sleep overlay** — block until dream state completes, then show the overlay. Rejected because dream state can take 1–5 minutes; the user would see a frozen UI rather than a smooth sleeping animation.
- **ALT-005**: **Use IndexedDB for checkpoint persistence** — store the checkpoint in browser storage rather than a backend JSON file. Rejected because the checkpoint must be accessible to the backend shutdown handler (`main.py`) which has no access to browser storage. A backend JSON file is the only reliable cross-component store.
- **ALT-006**: **Re-use a single animation phase for both sleep and shutdown** — detect context from a flag rather than separate `'sleeping'` vs `'shutting_down'` phases. Rejected because the two animations diverge in their completion callbacks: sleep → shows sleep overlay + triggers dream; shutdown → calls `POST /system/shutdown`. Keeping them as distinct phases makes the code unambiguous.
- **ALT-007**: **Wake on mouse movement** — trigger wake on `mousemove` event. Rejected because accidental cursor movement (moving the mouse to another window) would constantly interrupt sleep. Only intentional interaction (click, keypress, mic) should trigger wake.

## 4. Dependencies

- **DEP-001**: `feature-dream-state-shutdown-pipeline-1.md` — **hard dependency**. `backend/dream.py` and `backend/dream_routes.py` must exist before this plan can be implemented. Phase 6 of this plan modifies those files to add `from_ts` support and checkpoint writing.
- **DEP-002**: `feature-boot-shutdown-animation-1.md` — **hard dependency**. The `_animPhase` closure variable and setter mechanism, `_sphereAnimPhase` module-level guard, and the disabled-controls pattern must be in place before Phases 3 and 7 can be implemented.
- **DEP-003**: `feature-session-activity-logging-1.md` — **required for dream state** (transitive via DEP-001). The JSONL session log must exist and be written continuously for `build_transcript()` to process.
- **DEP-004**: `frontend/config.js` — already exists. New constants `SLEEP_AFTER_MS`, `SLEEP_ANIMATION_MS`, `WAKE_ANIMATION_MS` added in Phase 1.
- **DEP-005**: `backend/session_log.py` — provides `get_session_id()` used by the shutdown handler and `_write_checkpoint()`.

## 5. Files

- **FILE-001**: `frontend/config.js` — **modified**. Add `SLEEP_AFTER_MS`, `SLEEP_ANIMATION_MS`, `WAKE_ANIMATION_MS`.
- **FILE-002**: `frontend/app.js` — **modified**. Add inactivity tracker, `enterSleepMode()`, `_onSleepAnimationComplete()`, `wakeSleepMode()`, `_onWakeAnimationComplete()`, `_triggerSleepDream()`, `_sendWakeGreeting()`, `'sleeping'`/`'waking'` animation blocks in `animate()`, wake event listeners, `sendToOllama()` `systemNote` extension.
- **FILE-003**: `frontend/index.html` — **modified**. Add `#sleep-overlay` div with `.sleep-label`.
- **FILE-004**: `frontend/style.css` — **modified**. Add `.sleep-overlay`, `.sleep-label`, `@keyframes sleep-breathe`, `.starling.sleep-mode` rules.
- **FILE-005**: `backend/dream.py` — **modified**. Add `from_ts` parameter to `build_transcript()` and `run_dream_state()`. Add `_write_checkpoint()`, `read_checkpoint()`, and `CHECKPOINT_PATH` constant.
- **FILE-006**: `backend/dream_routes.py` — **modified**. Add `from_ts` field to `POST /dream/run` request body model; pass it to `run_dream_state()`.
- **FILE-007**: `backend/main.py` — **modified**. Update shutdown handler to call `dream.read_checkpoint()` and pass `from_ts` to `run_dream_state()`.
- **FILE-008**: `.gitignore` — **modified**. Add `backend/memory/dream/`.
- **FILE-009**: `backend/memory/dream/checkpoint.json` — **runtime artifact** (not tracked in git). Written by `_write_checkpoint()`, read by `read_checkpoint()` and the shutdown handler.

## 6. Testing

- **TEST-001**: Set `SLEEP_AFTER_MS = 5000` in `config.js`. Load the UI and wait 5 seconds without interaction. Verify the sleep animation plays — sphere shrinks with oscillation and curves off screen — followed by the sleep overlay fading in with a pulsing "SLEEPING" label. Restore `SLEEP_AFTER_MS` to default after test.
- **TEST-002**: During sleep state, verify all UI controls are non-interactive (mic button, text input, send button, power button all have `disabled` attribute set).
- **TEST-003**: While in sleep state, click anywhere on the `#sleep-overlay`. Verify the wake animation plays — sphere appears far away and grows to full size with decreasing oscillation — and controls are re-enabled when it completes.
- **TEST-004**: While in sleep state, press any keyboard key. Verify wake animation plays identically to TEST-003.
- **TEST-005**: After wake animation completes, verify Starling speaks a greeting message and the message appears in the chat panel. Verify the greeting does not appear as a user message (only the assistant's response).
- **TEST-006**: Verify `backend/memory/dream/checkpoint.json` is created after the sleep dream state completes, containing a valid ISO 8601 `last_dream_at` timestamp.
- **TEST-007**: Trigger sleep twice in the same session (set `SLEEP_AFTER_MS = 5000`, interact, wait, interact again, wait). Verify that the second dream state only processes events from after the first dream's `last_dream_at` timestamp — confirm by checking the transcript passed to the LLM shows only new events.
- **TEST-008**: After two sleep cycles in one session, initiate a shutdown via `POST /system/shutdown`. Verify the shutdown dream state reads `checkpoint.json`, uses `last_dream_at` as `from_ts`, and only processes events since the second sleep dream. Verify no events are processed twice across all three dream runs.
- **TEST-009**: Set `SLEEP_AFTER_MS = 5000` and have Starling speak a long response. Verify the inactivity timer does not fire while `sphereStateRef.current === 'speaking'`. Verify sleep is triggered only after speech completes and `SLEEP_AFTER_MS` of additional inactivity elapses.
- **TEST-010**: Verify that if no user interactions have occurred since the last dream checkpoint, `build_transcript()` returns an empty string and `run_dream_state()` returns early with `completed_passes = []` — no output files are written for an empty interval.
- **TEST-011**: Verify that `_sphereAnimPhase !== 'none'` during the boot animation prevents the inactivity timer from triggering sleep. Load the page, immediately check that no sleep event fires before the boot animation (`BOOT_ANIMATION_MS`) completes.

## 7. Risks & Assumptions

- **RISK-001**: **Multiple wake listeners firing simultaneously** — if the user clicks the overlay and presses a key at the same moment, `wakeSleepMode()` could be called twice. The `if (!_isSleeping)` guard at the top of `wakeSleepMode()` prevents double-execution since `_isSleeping` is set to `false` on the first call.
- **RISK-002**: **Dream state still running when user wakes** — `_triggerSleepDream()` fires asynchronously; the dream could still be processing when the user wakes. The wake flow does not wait for the dream to complete. The dream completes in background and writes the checkpoint when done. This is acceptable.
- **RISK-003**: **`_sleepEnteredAt` drift for the wake greeting** — if the dream state takes longer than expected and the user wakes while the dream is still running, `_sleepEnteredAt` still reflects when sleep began, so the greeting elapsed-time calculation remains correct.
- **RISK-004**: **Checkpoint written for a partial dream** — if all three dream passes fail (LLM unavailable), `_write_checkpoint()` is still called (TASK-018 calls it after `run_dream_state()` returns). The failed pass events would then be excluded from the next dream run. Mitigation: modify `_write_checkpoint()` to only be called when `result.completed_passes` is non-empty — skip checkpoint if all passes failed.
- **RISK-005**: **`GET /health` on every sleep trigger is wasteful** — `_triggerSleepDream()` calls `/health` to retrieve `current_session`. If the health endpoint is slow or unavailable, the dream trigger fails silently. Mitigation: cache `current_session` on startup (TASK-016) so `/health` is only called once.
- **RISK-006**: **`sendToOllama()` extension for `systemNote` adds complexity** — injecting an ephemeral system message that is not persisted to `conversationHistory` requires careful management to ensure the LLM context is not corrupted. The implementation must splice the note in for the outbound request only and never push it to `conversationHistory`.
- **ASSUMPTION-001**: `feature-dream-state-shutdown-pipeline-1.md` and `feature-boot-shutdown-animation-1.md` are both fully implemented before this plan is executed.
- **ASSUMPTION-002**: The Three.js `animate()` RAF loop closure variables (`_animPhase`, `_animStart`) are made writable via setter functions as specified in `feature-boot-shutdown-animation-1.md` (TASK-006 of that plan). This plan adds `'sleeping'` and `'waking'` to the set of valid phase values without changing the setter interface.
- **ASSUMPTION-003**: `SLEEP_AFTER_MS = 600000` (10 minutes) is a reasonable default. It should be adjusted by the user based on typical session patterns. The value is easy to change in `config.js`.
- **ASSUMPTION-004**: A "session" in the context of this plan means a single continuous run of the backend process (one `session_<timestamp>.jsonl` file). If the backend is restarted between sleep cycles, a new session begins, and `read_checkpoint()` will return `None` (different `session_id`), causing the new session's dream to summarize only from the new session start. This is correct behaviour.

## 8. Related Specifications / Further Reading

- [feature-dream-state-shutdown-pipeline-1.md](feature-dream-state-shutdown-pipeline-1.md) — Hard dependency. Defines `dream.py`, `dream_routes.py`, `run_dream_state()`, and `build_transcript()` that this plan extends.
- [feature-boot-shutdown-animation-1.md](feature-boot-shutdown-animation-1.md) — Hard dependency. Defines the `_animPhase` / `_sphereAnimPhase` animation state system and the camera animation patterns reused by the sleep and wake animations.
- [feature-session-activity-logging-1.md](feature-session-activity-logging-1.md) — Transitive dependency via the dream state plan. The JSONL log is the data source for `build_transcript()`.
- [feature-simple-on-off-launcher-1.md](feature-simple-on-off-launcher-1.md) — Shutdown launcher; its `shutdown_handler` extended wait time (from the dream state plan) is relevant when the shutdown dream uses `read_checkpoint()` and processes a smaller event window.
- [Three.js PerspectiveCamera](https://threejs.org/docs/#api/en/cameras/PerspectiveCamera)
- [Web Inactivity Detection — MDN setInterval](https://developer.mozilla.org/en-US/docs/Web/API/setInterval)
