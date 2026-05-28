---
goal: Boot & Shutdown Sphere Animation + In-UI System Power Control
version: '1.0'
date_created: 2026-05-20
last_updated: 2026-05-27
owner: simps
status: 'Complete'
tags: [feature, frontend, animation, ux, three.js, launcher, power-management]
---

# Introduction

![Status: Complete](https://img.shields.io/badge/status-Complete-brightgreen)

When S.T.A.R.L.I.N.G. starts up or shuts down, the user currently sees the UI either appear instantly or disappear abruptly. This plan introduces two cinematic Three.js camera animations — a **boot sequence** where the Starling sphere and orbiting light orbs travel in from deep space with a controlled back-and-forth drift, growing larger until they settle into the default position; and a **shutdown sequence** where the sphere and orbs slowly retreat into the background, oscillating as they shrink, before curving off-screen and vanishing. Both animations are configurable in duration so they can be tuned to match actual boot/shutdown times.

This plan also adds a **power-off button** to the UI header so the user can initiate a clean shutdown without switching to a terminal, and wires it to a new `POST /system/shutdown` backend endpoint that gracefully terminates the process.

## 1. Requirements & Constraints

- **REQ-001**: A boot animation must play immediately on page load, before the user can interact with any controls. The sphere camera must start far away (`z ≈ 80`) and travel toward the default camera position (`z = 6.2`) over `BOOT_ANIMATION_MS` milliseconds.
- **REQ-002**: The boot animation must include a controlled oscillation on the camera's x/y axes that starts with a large amplitude and tapers to zero as the sphere settles into position.
- **REQ-003**: A shutdown animation must play when the user clicks the power-off button. The camera must travel from its current position (`z = 6.2`) back to far distance (`z ≈ 80`) over `SHUTDOWN_ANIMATION_MS` milliseconds, with a constant lateral oscillation that ends with a curve off-screen.
- **REQ-004**: `BOOT_ANIMATION_MS` and `SHUTDOWN_ANIMATION_MS` must be exported constants in `frontend/config.js` so they can be adjusted without touching animation code.
- **REQ-005**: The actual backend `POST /system/shutdown` call must only fire **after** the shutdown animation completes, so the UI is visible for the full animation duration before the server terminates.
- **REQ-006**: All UI controls (mic button, text input, send button) must be disabled / non-interactive for the duration of the boot animation.
- **REQ-007**: A power-off button must be added to the header (`<header class="hdr">`) in `frontend/index.html` styled consistently with the existing monospace/dark aesthetic.
- **REQ-008**: `POST /system/shutdown` must be a new FastAPI endpoint in `backend/main.py` that is restricted to `localhost` callers only (same guard pattern as `GET /log/sessions`). It must call `session_log.log_session_end()` and then initiate graceful ASGI shutdown.
- **SEC-001**: `POST /system/shutdown` must reject non-localhost requests with HTTP 403. The request origin is determined by `Request.client.host`.
- **CON-001**: No new npm / Python packages may be introduced. The animation runs inside the existing Three.js `requestAnimationFrame` loop already established in `initSphere()`.
- **CON-002**: The existing Three.js camera position (`camera.position.z = 6.2`) and FOV (`40`) must remain unchanged for all normal operation. The animation only modifies camera position during the animation phases.
- **CON-003**: The animation must not interfere with any other running state changes (e.g., `setState('idle')` can still be called during boot without breaking the animation).
- **GUD-001**: The boot animation exit should transition into `setState('idle')` so the sphere is in the correct visual state once animation completes.
- **GUD-002**: The shutdown animation should transition into `setState('idle')` (disabling orb colour effects) partway through to give the retreating sphere a calm, neutral appearance.
- **PAT-001**: Follow the existing camera animation pattern: mutate `camera.position` inside the `animate()` RAF loop using an elapsed-time `t ∈ [0,1]` progress value rather than CSS transitions or GSAP.
- **PAT-002**: Expose animation phase via a module-level variable `_sphereAnimPhase` (`'booting' | 'shutting_down' | 'none'`) so other app.js code can check if an animation is in progress.

## 2. Implementation Steps

### Implementation Phase 1 — Configuration Constants

- GOAL-001: Add `BOOT_ANIMATION_MS` and `SHUTDOWN_ANIMATION_MS` to `frontend/config.js` so animation duration is a single-source-of-truth tunable.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `frontend/config.js`, add `export const BOOT_ANIMATION_MS = 6000;` (6 seconds). Add `export const SHUTDOWN_ANIMATION_MS = 4000;` (4 seconds). Add a comment: `// Increase these values if boot/shutdown takes longer than the animation.` | ✓ | 2026-05-27 |
| TASK-002 | In `frontend/app.js`, import `BOOT_ANIMATION_MS` and `SHUTDOWN_ANIMATION_MS` from `./config.js` alongside the existing `BACKEND_BASE` import. | ✓ | 2026-05-27 |

### Implementation Phase 2 — Boot Animation (Sphere Approach)

- GOAL-002: Implement the boot animation inside `initSphere()` — camera starts far (`z=80`), drifts in from space with decreasing lateral oscillation, and settles at `z=6.2`. All UI controls remain disabled until animation completes.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | At the top of `initSphere()`, after `camera.position.z = 6.2`, override to `camera.position.z = 80`. Declare `let _animPhase = 'booting'` and `let _animStart = Date.now()` as local variables inside `initSphere()` (they live in the `animate()` closure). | ✓ | 2026-05-27 |
| TASK-004 | In the `animate()` function body, add a boot-phase block executed when `_animPhase === 'booting'`. Compute `const p = Math.min((Date.now() - _animStart) / BOOT_ANIMATION_MS, 1)`. Apply an ease-out-cubic easing: `const eased = 1 - Math.pow(1 - p, 3)`. Set `camera.position.z = 80 + (6.2 - 80) * eased`. Compute lateral oscillation: `const amp = (1 - eased) * 2.8; camera.position.x = amp * Math.sin(p * Math.PI * 6); camera.position.y = amp * 0.45 * Math.cos(p * Math.PI * 4.7 + 0.9)`. When `p >= 1`, set `camera.position.set(0, 0, 6.2)`, `_animPhase = 'none'`, call `_onBootAnimationComplete()`. | ✓ | 2026-05-27 |
| TASK-005 | Define `_onBootAnimationComplete()` as a function in `app.js` (after `initSphere` is called). It must: (1) call `setState('idle')`, (2) re-enable the mic button, text input, and send button (remove the `disabled` attribute added in TASK-007). | ✓ | 2026-05-27 |
| TASK-006 | Expose `_sphereAnimPhase` as a module-level variable in `app.js` that mirrors the value of `_animPhase` inside the closure. Update it whenever `_animPhase` changes by calling `_syncAnimPhase(phase)` — a simple setter that writes to the outer variable. This allows other code to check `if (_sphereAnimPhase !== 'none')`. | ✓ | 2026-05-27 |
| TASK-007 | On `DOMContentLoaded` (before `initSphere()` is called), add `disabled` attribute to `#mic-btn`, `#send-btn`, and `#text-input` so they are non-interactive during boot animation. This is undone by `_onBootAnimationComplete()` (TASK-005). | ✓ | 2026-05-27 |

### Implementation Phase 3 — Shutdown Animation (Sphere Retreat)

- GOAL-003: Implement the shutdown animation — camera travels from `z=6.2` back to `z=80` with lateral oscillation and a final curve off-screen, then fires `POST /system/shutdown` after completion.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | Define `startShutdownAnimation()` as an exported-style function in `app.js`. It must: (1) disable all UI controls (mic, send, text input, power button), (2) call `setState('idle')` to reset orb colours to calm white, (3) set `_animPhase = 'shutting_down'` and `_animStart = Date.now()` (writing to the closure variables via a setter). | ✓ | 2026-05-27 |
| TASK-009 | In the `animate()` function body, add a shutdown-phase block when `_animPhase === 'shutting_down'`. Compute `const p = Math.min((Date.now() - _animStart) / SHUTDOWN_ANIMATION_MS, 1)`. Apply ease-in-cubic: `const eased = Math.pow(p, 3)`. Set `camera.position.z = 6.2 + (80 - 6.2) * eased`. Oscillation: `camera.position.x = 2.4 * Math.sin(p * Math.PI * 5)`. Final curve: when `p > 0.75`, ramp `camera.position.x += ((p - 0.75) / 0.25) * 18` and `camera.position.y = ((p - 0.75) / 0.25) * 10` so the sphere arcs off screen in the last 25% of the animation. When `p >= 1`, set `_animPhase = 'done'` and call `_onShutdownAnimationComplete()`. | ✓ | 2026-05-27 |
| TASK-010 | Define `_onShutdownAnimationComplete()` in `app.js`. It must call `fetch(\`${BACKEND_BASE}/system/shutdown\`, { method: 'POST' }).catch(() => {})`. After a 1200 ms delay (to allow the server to begin shutting down), display a full-screen "OFFLINE" overlay (see TASK-015). | ✓ | 2026-05-27 |

### Implementation Phase 4 — Power-Off Button (UI)

- GOAL-004: Add a power-off button to the header that initiates the shutdown animation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-011 | In `frontend/index.html`, inside `<header class="hdr">`, add a power button after `<div class="hdr-stats">`: `<button class="power-btn" id="power-btn" title="Shut down S.T.A.R.L.I.N.G.">⏻</button>`. | ✓ | 2026-05-27 |
| TASK-012 | In `frontend/style.css`, add `.power-btn` styles: `position: absolute; top: 14px; right: 14px; background: transparent; border: 1px solid rgba(200,200,200,0.15); color: rgba(200,200,200,0.35); font-size: 14px; width: 28px; height: 28px; border-radius: 3px; cursor: pointer; font-family: inherit; letter-spacing: 0; transition: color 0.2s, border-color 0.2s, box-shadow 0.2s`. Add hover state: `border-color: rgba(255,80,80,0.5); color: rgba(255,100,100,0.8); box-shadow: 0 0 8px rgba(255,60,60,0.15)`. Add disabled state: `opacity: 0.2; cursor: default`. | ✓ | 2026-05-27 |
| TASK-013 | In `frontend/app.js`, get a reference to `#power-btn` (`const powerBtn = document.getElementById('power-btn')`). Add `powerBtn.addEventListener('click', () => { if (_sphereAnimPhase !== 'none') return; startShutdownAnimation(); })`. | ✓ | 2026-05-27 |
| TASK-014 | Add a confirmation step before starting the shutdown animation: on first click, the power button's label changes to `✕` and a 2-second timeout resets it. On second click within that window (or if no confirmation behaviour is desired, this task can be skipped in favor of a direct single-click shutdown — to be decided at implementation time). | ✓ | 2026-05-27 |
| TASK-015 | In `frontend/index.html`, add a hidden full-screen offline overlay div: `<div class="offline-overlay hidden" id="offline-overlay"><div class="offline-label">OFFLINE</div></div>`. In `frontend/style.css`, style it: `position:fixed; inset:0; background:#060606; display:flex; align-items:center; justify-content:center; z-index:9999; opacity:0; transition:opacity 1.2s ease`. When class `visible` is added: `opacity:1`. The `.offline-label` is `font-family: 'Share Tech Mono'; font-size: 11px; letter-spacing: 6px; color: rgba(200,200,200,0.2); text-transform: uppercase`. In `_onShutdownAnimationComplete()`, add class `visible` to make it fade in. | ✓ | 2026-05-27 |

### Implementation Phase 5 — Backend Shutdown Endpoint

- GOAL-005: Add `POST /system/shutdown` to `backend/main.py` — localhost-only, logs session end, and initiates graceful process exit.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-016 | In `backend/main.py`, add the following route after the `/health` endpoint: `@app.post("/system/shutdown")` with `async def system_shutdown(request: Request)`. Import `Request` from `fastapi` (already imported or add to existing import). Check `request.client.host not in {"127.0.0.1", "::1", "localhost"}` → raise `HTTPException(403, "Forbidden")`. | ✓ | 2026-05-27 |
| TASK-017 | In `system_shutdown()`, call `session_log.log_session_end()`. Then trigger graceful shutdown by scheduling `os.kill(os.getpid(), signal.SIGTERM)` in a background task with a short delay (`asyncio.get_event_loop().call_later(0.5, lambda: os.kill(os.getpid(), signal.SIGTERM))`). Add `import signal` to `main.py` imports. Return `{"ok": True, "message": "Shutting down"}`. | ✓ | 2026-05-27 |
| TASK-018 | If `feature-dream-state-shutdown-pipeline-1.md` has been implemented: before calling `os.kill`, call the dream-state trigger in a `BackgroundTask` so the dream pipeline runs during the shutdown delay. If not yet implemented, leave a `# TODO: trigger dream state here` comment. | ✓ | 2026-05-27 |

### Implementation Phase 6 — Integration with Launcher (Simple On/Off)

- GOAL-006: Ensure the shutdown button UI integrates cleanly with the `scripts/stop.py` and `start.bat` launcher from `feature-simple-on-off-launcher-1.md`. No new files needed — this phase documents and validates integration behaviour.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-019 | Verify that when `POST /system/shutdown` sends `SIGTERM` to the uvicorn process, the `scripts/launch.py` watchdog (TASK-007 of `feature-simple-on-off-launcher-1.md`) detects the exit and also terminates `llama-server`. Document this in `README.md` under the "Shutdown" section. | ✓ | 2026-05-27 |
| TASK-020 | Verify that `scripts/stop.py` (`make down`) produces the same end state as clicking the power button in the UI. Both paths must result in both processes terminated and `.starling.pid` deleted. | ✓ | 2026-05-27 |

## 3. Alternatives

- **ALT-001**: **CSS `transform: scale()` on the sphere canvas element** — scale the `<canvas>` from `scale(0.01)` to `scale(1)` via CSS animation. Rejected because CSS scaling does not move the Three.js camera, so the orbs and halo would scale incorrectly and the z-depth perspective effect would be lost.
- **ALT-002**: **Three.js `camera.fov` animation (zoom via FOV change)** — a narrowing FOV makes distant objects appear larger (telephoto effect). Rejected because FOV changes affect the entire scene proportionally and cannot produce the parallax depth effect of a true camera z-movement. The `z` approach gives a genuine perspective change.
- **ALT-003**: **GSAP (GreenSock Animation Platform)** — a mature JS animation library with built-in easing and timeline control. Rejected to avoid introducing a new frontend dependency; the existing RAF loop is sufficient and already established.
- **ALT-004**: **Page-level CSS fade (black overlay)** — simply fade the entire page to black on shutdown instead of animating the sphere. Rejected as this misses the opportunity to show the sphere retreating, which was the user's explicit visual intent.
- **ALT-005**: **Separate "intro" animation loaded before `app.js`** — play a standalone HTML animation page before redirecting to the main UI. Rejected because it requires a server-side redirect, breaks deep links, and creates a navigation gap rather than a seamless in-place transition.
- **ALT-006**: **`window.close()` to shut down** — close the browser tab on shutdown. Rejected because modern browsers block `window.close()` calls not initiated by the window's own script, and it does not terminate the backend.

## 4. Dependencies

- **DEP-001**: `Three.js` — already loaded via CDN in `frontend/index.html`. The animation runs entirely inside the existing `animate()` RAF loop in `initSphere()`.
- **DEP-002**: `frontend/config.js` — already exists with `BACKEND_BASE`. New constants `BOOT_ANIMATION_MS` and `SHUTDOWN_ANIMATION_MS` added here.
- **DEP-003**: `feature-simple-on-off-launcher-1.md` — Phase 6 of this plan validates integration with `launch.py`'s watchdog. This plan can be implemented independently but full launcher integration requires that plan also being complete.
- **DEP-004**: `backend/session_log.py` — already implemented (from `feature-session-activity-logging-1.md`). `session_log.log_session_end()` is called by the shutdown endpoint.

## 5. Files

- **FILE-001**: `frontend/config.js` — **modified**. Add `BOOT_ANIMATION_MS` and `SHUTDOWN_ANIMATION_MS` exports.
- **FILE-002**: `frontend/app.js` — **modified**. Add animation phase state, boot animation block inside `animate()`, shutdown animation block inside `animate()`, `startShutdownAnimation()`, `_onBootAnimationComplete()`, `_onShutdownAnimationComplete()`, power button event listener, boot-time UI control disable/enable.
- **FILE-003**: `frontend/index.html` — **modified**. Add `#power-btn` to header. Add `#offline-overlay` full-screen div.
- **FILE-004**: `frontend/style.css` — **modified**. Add `.power-btn` styles (normal, hover, disabled). Add `.offline-overlay` and `.offline-label` styles.
- **FILE-005**: `backend/main.py` — **modified**. Add `POST /system/shutdown` endpoint. Add `import signal` to imports.

## 6. Testing

- **TEST-001**: On page load, verify the sphere starts visually small (far away) and grows to full size over approximately `BOOT_ANIMATION_MS` ms. Confirm mic button, text input, and send button are non-interactive during animation.
- **TEST-002**: After boot animation completes, verify all UI controls become interactive and the sphere is at its default size and position.
- **TEST-003**: Click the power-off button. Verify the shutdown animation plays — sphere visibly shrinks, oscillates, and curves off-screen over `SHUTDOWN_ANIMATION_MS` ms.
- **TEST-004**: After `SHUTDOWN_ANIMATION_MS`, verify `POST /system/shutdown` is called (check network tab or backend log) and the `#offline-overlay` fades in.
- **TEST-005**: Verify `POST /system/shutdown` from a non-localhost client returns HTTP 403.
- **TEST-006**: Set `BOOT_ANIMATION_MS = 500` and `SHUTDOWN_ANIMATION_MS = 500` in `config.js`. Verify both animations complete in approximately 500 ms. Reset to defaults.
- **TEST-007**: Verify the Three.js camera is exactly at `position(0, 0, 6.2)` after the boot animation completes (no residual offset on x/y).
- **TEST-008**: Verify clicking the power button during the boot animation does nothing (guard `_sphereAnimPhase !== 'none'`).

## 7. Risks & Assumptions

- **RISK-001**: If `BOOT_ANIMATION_MS` is shorter than actual server startup time, the UI becomes interactive before the backend is ready. Mitigate: the existing `fetchSystemStatus()` call on `DOMContentLoaded` already handles backend-not-ready gracefully; this is unchanged.
- **RISK-002**: On low-performance hardware, the Three.js RAF loop may run below 30 fps, causing the animation to feel jerky. The animation uses elapsed-wall-clock time (not frame count) so duration correctness is preserved regardless of frame rate.
- **RISK-003**: `os.kill(os.getpid(), signal.SIGTERM)` inside the FastAPI async handler terminates the uvicorn process before the HTTP response is sent to the frontend. Mitigate: use `asyncio.get_event_loop().call_later(0.5, ...)` to defer the signal by 500 ms, giving the response time to flush.
- **RISK-004**: The `#offline-overlay` fade-in may not render if the browser tab is closed immediately after the backend terminates. This is acceptable — the overlay is cosmetic only.
- **ASSUMPTION-001**: Three.js `camera.position` mutations inside `animate()` are thread-safe (they are — the JS event loop is single-threaded).
- **ASSUMPTION-002**: The boot animation plays every time the page loads, including on manual browser refresh. This is intentional and consistent with the "distract from boot time" goal.
- **ASSUMPTION-003**: `BOOT_ANIMATION_MS = 6000` is a reasonable default that covers typical llama-server model load times (30–90 s handled by the backend's own warm-up; the 6 s animation covers initial UI readiness). The value should be adjusted based on real-world timing after first testing.

## 8. Related Specifications / Further Reading

- [feature-simple-on-off-launcher-1.md](feature-simple-on-off-launcher-1.md) — Single-command launcher; the `launch.py` watchdog receives the SIGTERM triggered by the shutdown endpoint.
- [feature-dream-state-shutdown-pipeline-1.md](feature-dream-state-shutdown-pipeline-1.md) — The shutdown animation plays while the dream state pipeline processes in the background.
- [feature-session-activity-logging-1.md](feature-session-activity-logging-1.md) — `session_log.log_session_end()` is called by the shutdown endpoint before process termination.
- [Three.js PerspectiveCamera documentation](https://threejs.org/docs/#api/en/cameras/PerspectiveCamera)
