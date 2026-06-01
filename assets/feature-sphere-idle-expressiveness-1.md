---
goal: Add unpredictable idle micro-animations and an abstract full-sphere "blink" to the living sphere
version: 1.2
date_created: 2026-05-31
last_updated: 2026-06-01
owner: Daniel Simpson
status: 'In progress'
tags: [feature, frontend, animation, sphere, idle]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

This plan adds two expressiveness behaviours to the living sphere rendered by `initSphere()` in [frontend/app.js](frontend/app.js), both active only during the `idle` state. (1) **Micro-animations** — small, infrequent, randomly-scheduled events: a brief whole-surface pulse, a single orb briefly brightening, or a small localized surface ripple. They fire unpredictably so the sphere feels alive even when Starling is not engaged. (2) **Blink equivalent** — not an eye, but a brief full-sphere dim-and-recover on a randomized interval, an abstract "tell" the brain reads as organic.

Current-state review of the live renderer drives this outline. Today the sphere has exactly one CPU deformation pipeline in `animate()`: while `state === 'listening'` it uses analyser-driven radial scaling, and in every other state it uses `target = proximityPush + idleNoise` with smoothed per-vertex displacement. Orb light intensity is also recomputed from a fresh baseline each frame (`6` listening, `5` speaking, `3.5` otherwise) and then scaled by `_orbOpacity`; atmospheric reach comes from the existing bloom/Fresnel glow path plus the rim mesh, not from any current Voronoi or breath module. This plan therefore injects idle expressiveness only into those existing live control points, keeps non-idle behaviour byte-for-byte unchanged, and avoids depending on companion features that are still only planned.

Both effects are scheduled by a deterministic, unit-testable event scheduler (pure functions in a new ES module mirroring [frontend/animation-easings.js](frontend/animation-easings.js)) and are applied as transient additive modulations on top of the existing orb-intensity, glow-strength, rim-opacity, and non-listening surface-displacement logic inside the single `animate()` loop. They run ONLY while `idle` and are fully suppressed during `listening`/`thinking`/`speaking`, during lifecycle choreography, and under `prefers-reduced-motion`, so no existing behaviour changes.

## 1. Requirements & Constraints

- **REQ-001**: Idle micro-animations MUST include at least three event kinds: (a) a brief whole-surface pulse (transient radial expansion+recover), (b) a single random orb briefly brightening then fading back, and (c) a small localized surface ripple at a random point.
- **REQ-002**: Micro-animation events MUST occur infrequently and at unpredictable intervals (randomized inter-event delay within a configured min/max range), with at most one event of a given kind active at a time.
- **REQ-003**: The "blink" MUST be a brief full-sphere dim (reduce overall orb light intensity and surface emissive contribution) followed by a smooth recover, on a randomized interval distinct from the micro-animation schedule.
- **REQ-004**: Each event MUST have a short, bounded duration and MUST return the sphere exactly to its pre-event baseline (no cumulative drift in intensity or displacement).
- **REQ-005**: All idle expressiveness MUST be active ONLY when `sphereStateRef.current === 'idle'`; any transition to `listening`/`transcribing`/`thinking`/`speaking` MUST immediately cancel in-flight idle events and restore baseline.
- **REQ-006**: Idle expressiveness MUST be suppressed while `lifecycleActive` is true (boot/shutdown/sleep/wake) and while `_prefersReducedMotion` is set.
- **REQ-007**: The feature MUST preserve the current renderer split in [frontend/app.js](frontend/app.js): listening keeps the existing analyser-driven deformation path unchanged, and idle expressiveness only layers into the current non-listening `proximityPush + idleNoise` branch.
- **REQ-008**: Event-start-only choices (target orb for `orbBrighten`, origin point for `ripple`) MUST be made exactly once per activation and remain stable for that activation; the scheduler API therefore MUST expose a monotonic activation token/sequence so `app.js` can detect a new event without relying on `progress === 0`.
- **SEC-001**: No new third-party scripts, CDNs, npm packages, or network calls may be introduced; Three.js r160 via the existing CDN `<script>` is the only external dependency and is unchanged.
- **SEC-002**: No user input, LLM output, or remote data may influence the scheduling or animation math; inputs are limited to internal state, elapsed time, and a pseudo-random source (prevents injection into render logic).
- **CON-001**: All motion MUST be driven from the single existing `animate()` requestAnimationFrame loop using the already-computed `t`, `delta`, and `state`; no second animation loop or `setTimeout`/`setInterval` may be used for scheduling (scheduling MUST be delta-accumulated inside `animate()` so it pauses with the tab).
- **CON-002**: The per-frame cost MUST be negligible — event scheduling is O(1) per frame and the surface-ripple event reuses the existing per-vertex displacement pass with no new per-frame heap allocations.
- **CON-003**: Events MUST compose additively with the existing idle micro-noise, proximity push, orb colour/intensity, atmospheric glow (`_glowStrength` / Fresnel fallback), rim mesh, and lifecycle logic without overriding higher-priority state behaviour.
- **CON-004**: The effect MUST degrade gracefully when `THREE === 'undefined'` or `!canvas`; the existing early returns in `initSphere()` MUST remain intact.
- **CON-005**: The implementation MUST not introduce new persistent baseline state for displacement or light intensity; it MUST continue to derive orb intensity, orb opacity, and per-vertex target displacement fresh each frame and apply idle expressiveness only as transient addends/multipliers on those live baselines.
- **GUD-001**: All tunables (per-kind probability/weights, min/max inter-event delays, event durations, pulse/brighten/ripple/blink amplitudes, blink interval range) MUST be grouped in one named config object mirroring the `BOOT_CHOREO`/`SLEEP_CHOREO` style in `initSphere()`.
- **GUD-002**: All scheduling and envelope math (random interval draw, event selection by weight, normalized 0→1 envelope shape) MUST be pure exported functions with an injectable `rng` so they are deterministically unit-testable in Node, following [frontend/animation-easings.js](frontend/animation-easings.js).
- **PAT-001**: Model each event as a normalized progress `0→1` over its duration with an envelope function (rise then fall, returning to 0) so REQ-004's "return to baseline" is structurally guaranteed.
- **PAT-002**: Apply event outputs as transient MULTIPLIERS/ADDENDS layered on the existing baselines (orb `light.intensity`, orb `mat.opacity`, per-vertex displacement `target`) computed each frame — never mutate the stored baseline configs.
- **PAT-003**: Compute a single per-frame `blinkDimMul` from the scheduler result and apply it consistently to all current full-sphere cues in the same frame: orb `light.intensity`, orb `mat.opacity` bump suppression, `_glowStrength`/bloom path, Fresnel fallback uniforms, rim visibility, and any sphere emissive-intensity term added for this feature.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Create a tested, GPU-free pure-function module for idle event scheduling and envelopes, including explicit event-activation tokens so the live renderer can attach one-off orb/ripple selections without ambiguity.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Create `frontend/idle-expressiveness.js` as an ES module with a header banner comment matching the `animation-easings.js` style; import nothing. | ✅ | 2026-06-01 |
| TASK-002 | Export `const IDLE_FX_CONFIG` grouping all tunables with inline comments: `microMinDelayMs: 4000`, `microMaxDelayMs: 12000`, `pulseDurationMs: 900`, `orbBrightenDurationMs: 1100`, `rippleDurationMs: 1300`, `blinkMinDelayMs: 6000`, `blinkMaxDelayMs: 16000`, `blinkDurationMs: 320`, `pulseAmp: 0.05`, `orbBrightenAmp: 1.8`, `orbOpacityAmp: 0.12`, `rippleAmp: 0.06`, `rippleFalloffPow: 10`, `blinkDimFactor: 0.45`, `blinkGlowFactor: 0.55`, `blinkRimOpacityFactor: 0.5`, and `kindWeights: { pulse: 0.4, orbBrighten: 0.35, ripple: 0.25 }`. The extra factors exist because the current renderer's full-sphere read is shared across orbs, glow, and the rim mesh. | ✅ | 2026-06-01 |
| TASK-003 | Export `export function drawInterval(rng, minMs, maxMs)` returning `minMs + rng() * (maxMs - minMs)` (uniform random delay; `rng` defaults to `Math.random`). | ✅ | 2026-06-01 |
| TASK-004 | Export `export function pickWeightedKind(rng, weights)` performing weighted selection over the `weights` object keys, returning a kind string; deterministic for a stubbed `rng`. | ✅ | 2026-06-01 |
| TASK-005 | Export `export function eventEnvelope(progress)` returning a normalized `0→1→0` envelope for `progress` in `[0,1]` (e.g. `Math.sin(progress * Math.PI)`), clamped to `[0,1]`, returning `0` outside the range. | ✅ | 2026-06-01 |
| TASK-006 | Export `export function blinkEnvelope(progress)` returning a normalized dip envelope `1→0→1`? No — return the DIM amount `0→1→0` where `1` is fully dimmed (e.g. fast-down/slow-up using a piecewise curve), so callers compute `intensity *= 1 - dim * (1 - blinkDimFactor)`. | ✅ | 2026-06-01 |
| TASK-007 | Export `export function makeIdleScheduler(cfg, rng = Math.random)` returning a controller object `{ update(deltaMs, active), reset() }` where `update` accumulates time, returns `{ event, blink }`, and each active descriptor includes an activation token: `event: { active, kind, progress, seq } | null`, `blink: { active, progress, seq } | null`. `seq` increments each time a new event/blink begins so `app.js` can detect starts deterministically. `reset()` clears timers, active descriptors, and pending delays. Time and `rng` are the only inputs. | ✅ | 2026-06-01 |

### Implementation Phase 2

- GOAL-002: Wire the scheduler into the live `initSphere()` control points without disturbing current non-idle behaviour.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | In [frontend/app.js](frontend/app.js), add import: `import { IDLE_FX_CONFIG, eventEnvelope, blinkEnvelope, makeIdleScheduler } from './idle-expressiveness.js';`. | ✅ | 2026-06-01 |
| TASK-009 | In `initSphere()`, create `const idleFx = makeIdleScheduler(IDLE_FX_CONFIG);` near the runtime-offset block, plus renderer-local runtime fields for one-off event selections: `let _idleEventSeqSeen = -1;`, `let _blinkSeqSeen = -1;`, `let _idleBrightOrbIdx = -1;`, and a stored ripple origin direction (`let _rippleOriginX = 0, _rippleOriginY = 0, _rippleOriginZ = 1;`). Use `origPos` as the ripple-direction source because the current sphere geometry is already a unit sphere; no second geometry or object array is needed. | ✅ | 2026-06-01 |
| TASK-010 | In `animate()`, immediately after `lifecycleActive` is computed and before the orb loop, compute `const idleEligible = state === 'idle' && !lifecycleActive && !_prefersReducedMotion;`. If `idleEligible`, call `const fx = idleFx.update(delta * 1000, true);`; otherwise call `idleFx.reset()` and clear the runtime event-selection fields so any state change instantly cancels in-flight idle expressiveness (REQ-005/006). | ✅ | 2026-06-01 |
| TASK-011 | Still in `animate()`, detect event starts by comparing `fx.event?.seq` / `fx.blink?.seq` to the stored seen values. On a new `orbBrighten` event, derive the target orb deterministically as `fx.event.seq % orbs.length`. On a new `ripple` event, derive the origin vertex deterministically as `fx.event.seq % numVerts` and cache that base vertex's normalized direction into `_rippleOriginX/Y/Z`. Do NOT re-pick targets while the same activation remains active. | ✅ | 2026-06-01 |
| TASK-012 | Apply the ORB-BRIGHTEN event inside the existing orb loop AFTER the current baseline assignments (`orb.light.intensity = baseIntensity * _orbOpacity; orb.mat.opacity = _orbOpacity;`). For the chosen orb only, add `IDLE_FX_CONFIG.orbBrightenAmp * eventEnvelope(fx.event.progress)` to `light.intensity`, add a smaller `IDLE_FX_CONFIG.orbOpacityAmp * envelope` to `mat.opacity` (clamped to `1`), and slightly lerp the mesh/light colour toward white. Non-selected orbs remain on the current baseline path. | ✅ | 2026-06-01 |
| TASK-013 | Apply the BLINK as a shared multiplier computed once per frame: `const blinkDimMul = fx.blink?.active ? 1 - blinkEnvelope(fx.blink.progress) * (1 - IDLE_FX_CONFIG.blinkDimFactor) : 1;`. Multiply every orb's final `light.intensity` by `blinkDimMul`; optionally damp any orb-brighten opacity bump by the same factor so the blink reads as a whole-sphere event rather than fighting the highlight. | ✅ | 2026-06-01 |
| TASK-014 | Apply the PULSE and RIPPLE only inside the existing non-listening deformation branch, at the current `const target = proximityPush + idleNoise` insertion point. Replace it with `const target = proximityPush + idleNoise + pulseDelta + rippleDelta`, where `pulseDelta = IDLE_FX_CONFIG.pulseAmp * eventEnvelope(...)` for `pulse`, and `rippleDelta = IDLE_FX_CONFIG.rippleAmp * eventEnvelope(...) * Math.pow(Math.max(0, ox * _rippleOriginX + oy * _rippleOriginY + oz * _rippleOriginZ), IDLE_FX_CONFIG.rippleFalloffPow)` for `ripple` using the base unit-sphere direction `(ox, oy, oz)` from `origPos`. The listening/analyser branch is intentionally untouched. | ✅ | 2026-06-01 |

### Implementation Phase 3

- GOAL-003: Route the blink through the actual current whole-sphere visual cues and preserve baseline restoration / lifecycle resets.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-015 | In `_resetAnimOffsets()` (used by dev replays and lifecycle completion), call `idleFx.reset()` and clear `_idleEventSeqSeen`, `_blinkSeqSeen`, `_idleBrightOrbIdx`, and the stored ripple origin so no idle event survives boot/shutdown/sleep/wake or a dev replay. | ✅ | 2026-06-01 |
| TASK-016 | Document and preserve the layering order in code comments: lifecycle/state/proximity baselines are computed first, idle expressiveness is applied second and only when `idleEligible`, and render-path state (`_glowStrength`, rim opacity, sphere emissive intensity) is recomputed from fresh baselines each frame before any blink multiplier is applied. | ✅ | 2026-06-01 |
| TASK-017 | Route the BLINK through the current atmospheric/full-sphere read that actually exists in the live renderer: scale the current glow target or final `_glowStrength` by `THREE.MathUtils.lerp(1, IDLE_FX_CONFIG.blinkGlowFactor, blinkEnvelope(...))`, scale `rimMat.opacity` from its baseline `0.08` toward `0.08 * IDLE_FX_CONFIG.blinkRimOpacityFactor`, and, if needed for readability, add a small `sphereMat.emissiveIntensity` baseline that is also dimmed by the same blink envelope. Do not depend on planned Voronoi/breath modules. | ✅ | 2026-06-01 |
| TASK-018 | Confirm displacement bounds against the actual current deformation terms (`proximityPush` up to `0.08`, idle noise `0.006`, idle pulse/ripple addends). Clamp the final radial scale to `[0.85, 1.2]` if the combined idle maximum can exceed the safe band; keep the clamp at the final `scale` assignment only so the smoothing pipeline remains continuous. | ✅ | 2026-06-01 |
| TASK-019 | Preserve the current non-listening branch's cheap-update behaviour: continue using `anyChange` / `needsUpdate`, but ensure pulse/ripple activity counts as a change source so positions refresh while an idle event is active even if the base `idleNoise` delta is below the old threshold. | ✅ | 2026-06-01 |

### Implementation Phase 4

- GOAL-004: Add automated tests and developer documentation for the new pure module and the current-renderer integration assumptions.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-020 | Create `tests/test_frontend_idle_expressiveness.py` mirroring `tests/test_frontend_animation_easings.py`: import `frontend/idle-expressiveness.js` via Node ESM; skip when `node` is absent. | ✅ | 2026-06-01 |
| TASK-021 | Assert `drawInterval`: with `rng` stubbed to `0` returns `minMs`, to `~1` returns ≈ `maxMs`, and the result is always within `[minMs, maxMs]`. | ✅ | 2026-06-01 |
| TASK-022 | Assert `pickWeightedKind`: deterministic for a stubbed `rng`; returns only keys present in `weights`; over many uniform draws the empirical distribution approximates the configured weights (tolerance-based). | ✅ | 2026-06-01 |
| TASK-023 | Assert `eventEnvelope`: returns `0` at `progress=0` and `progress=1`, peaks at `progress=0.5`, stays within `[0,1]`, and is `0` outside `[0,1]` (guarantees return-to-baseline, REQ-004). | ✅ | 2026-06-01 |
| TASK-024 | Assert `blinkEnvelope`: returns `0` (no dim) at the endpoints and reaches its max dim within the interval, staying within `[0,1]`. | ✅ | 2026-06-01 |
| TASK-025 | Assert `makeIdleScheduler` with a stubbed `rng` and stepped `deltaMs`: no event fires before the first drawn delay; exactly one event becomes active after it; the event clears after its duration; activation `seq` increments only when a new event/blink begins; `reset()` clears active events and timers; passing `active=false` to `update` produces no events (REQ-005/006/008). | ✅ | 2026-06-01 |
| TASK-026 | Assert `IDLE_FX_CONFIG` exposes every documented key with finite numeric values (and `kindWeights` summing to a positive total). No direct edit to `tests/test_frontend_smoke.py` is required because that test already globs and syntax-checks every `frontend/*.js` module, so the new file is covered automatically once created. | ✅ | 2026-06-01 |

### Implementation Phase 5

- GOAL-005: Close remaining post-implementation verification and optional docs follow-up.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-027 | Run manual visual acceptance from TEST-012 in a browser session while toggling state transitions (`idle` ↔ `listening/thinking/speaking`, lifecycle choreography, reduced-motion mode) and capture any required tuning changes as a follow-up patch. | | |
| TASK-028 | Optional documentation follow-up: add a concise note in [README.md](README.md) describing idle pulse/orb-brighten/ripple/blink behaviour if user-facing feature notes are being maintained. | | |

## 3. Alternatives

- **ALT-001**: Schedule events with `setTimeout`/`setInterval`. Rejected: timers keep firing while the tab is backgrounded and desync from the render clock; CON-001 mandates delta-accumulated scheduling inside `animate()` so it pauses with `requestAnimationFrame`.
- **ALT-002**: Hard-code a fixed event sequence/cadence. Rejected: REQ-002 requires unpredictable timing; a seeded/weighted random scheduler gives organic irregularity while staying testable via an injectable `rng`.
- **ALT-003**: Implement the blink by toggling the renderer clear colour or a CSS overlay. Rejected: a CSS/clear flash is a hard cut, not an organic dim-recover; modulating orb light intensity + surface emissive reads as a soft biological blink.
- **ALT-004**: Run idle events in all states (not just idle). Rejected: they would fight the meaningful state animations (listening/thinking/speaking) and dilute their signal; REQ-005 restricts them to idle.
- **ALT-005**: Persistent always-on low-level surface churn instead of discrete events. Rejected: the existing idle micro-noise already provides constant subtle motion; the brief is specifically about *infrequent, discrete, surprising* events.
- **ALT-006**: A separate offscreen state machine object outside `animate()`. Rejected: PAT-002/CON-001 keep all timing in the single render loop for frame-accurate, tab-aware behaviour and zero extra loops.
- **ALT-007**: Make the blink a literal eyelid/iris shape. Rejected: the brief explicitly wants an ABSTRACT tell (no eye); a full-sphere dim preserves the non-anthropomorphic aesthetic.
- **ALT-008**: Inject pulse/ripple into both deformation branches, including listening. Rejected: the live renderer already reserves the listening branch for analyser-driven deformation; adding idle expressiveness there would alter active-state behaviour and violate REQ-007.
- **ALT-009**: Detect event starts in `app.js` by checking `progress === 0` or `progress < epsilon`. Rejected: frame-delayed activation can skip exact zero; explicit scheduler activation tokens are deterministic and testable.

## 4. Dependencies

- **DEP-001**: Three.js r160 (already loaded via CDN in [frontend/index.html](frontend/index.html)) — orb `PointLight`/material and `SphereGeometry` position attribute. No version change.
- **DEP-002**: Existing `initSphere()` infrastructure in [frontend/app.js](frontend/app.js): `orbs`, per-orb `light`/`mat`, `sphereGeo`/`origPos`/`numVerts`/`dispSmooth`, `noiseOffset`, `delta`/`t`, `sphereStateRef`, `_prefersReducedMotion`, lifecycle flags, `_resetAnimOffsets()`, and the current non-listening `proximityPush + idleNoise` deformation branch.
- **DEP-003**: Existing whole-sphere atmospheric path in [frontend/app.js](frontend/app.js): `_glowStrength`, `bloomPass` / `fresnelUniforms`, `rimMat`, and `sphereMat`. These are the real current blink-reach surfaces.
- **DEP-004**: Node.js (optional) for the new unit tests; tests auto-skip when Node is absent, consistent with `tests/test_frontend_animation_easings.py`.

## 5. Files

- **FILE-001**: [frontend/idle-expressiveness.js](frontend/idle-expressiveness.js) — NEW. Pure-function tunables, random interval/weighted-kind draws, event + blink envelopes, and the delta-driven idle scheduler with an injectable `rng`.
- **FILE-002**: [frontend/app.js](frontend/app.js) — MODIFIED. Construct the scheduler in `initSphere()`; cache event-start selections; per-frame `update`/`reset` in `animate()`; apply pulse/ripple only in the current non-listening deformation branch; apply orb-brighten in the existing orb loop; route blink through orb intensity, glow, rim, and any added sphere emissive-intensity term; reset in `_resetAnimOffsets()`.
- **FILE-003**: [tests/test_frontend_idle_expressiveness.py](tests/test_frontend_idle_expressiveness.py) — NEW. Node-ESM unit tests for interval draws, weighted selection, envelopes, and scheduler lifecycle.
- **FILE-004**: [README.md](README.md) — OPTIONAL MODIFIED. One line noting the idle sphere occasionally pulses, brightens an orb, ripples, and "blinks", if a user-facing feature list is maintained.

## 6. Testing

- **TEST-001**: `drawInterval` returns `minMs` for `rng=0`, ≈ `maxMs` for `rng→1`, and always within `[minMs, maxMs]`.
- **TEST-002**: `pickWeightedKind` is deterministic under a stubbed `rng`, returns only configured keys, and approximates the weight distribution over many draws.
- **TEST-003**: `eventEnvelope` is `0` at both endpoints, peaks mid-interval, stays within `[0,1]`, and is `0` outside `[0,1]` (return-to-baseline guarantee).
- **TEST-004**: `blinkEnvelope` is `0` (no dim) at endpoints, reaches its max within the interval, and stays within `[0,1]`.
- **TEST-005**: `makeIdleScheduler`: no event before the first drawn delay; exactly one active event after; event clears after its duration; activation `seq` advances exactly once per activation; no cumulative drift across many cycles.
- **TEST-006**: `makeIdleScheduler` with `update(active=false)` never produces events, and `reset()` clears all active events/timers (REQ-005/006).
- **TEST-007**: `makeIdleScheduler` blink and micro-event schedules are independent (a blink can occur without a micro-event pending and vice versa).
- **TEST-008**: `IDLE_FX_CONFIG` exposes every documented key with finite values and `kindWeights` summing to a positive total.
- **TEST-009**: Regression guard — no exported function returns `NaN`/`Infinity` for representative finite inputs.
- **TEST-010**: `frontend/idle-expressiveness.js` exists and parses. This is automatically covered by [tests/test_frontend_smoke.py](tests/test_frontend_smoke.py), which already runs `node --check` across every `frontend/*.js` module.
- **TEST-011**: Baseline-restoration integration check (documented, semi-automated where possible): after an event completes, orb `light.intensity`, glow/rim dimming, and surface displacement return to their pre-event baselines (no drift).
- **TEST-012**: Manual/visual acceptance (documented in the test module docstring, not automated): while idle, the sphere occasionally and unpredictably pulses, brightens a single orb, or ripples, and periodically performs a brief full-sphere dim-and-recover "blink"; listening still uses only the existing analyser-driven deformation; proximity push and lifecycle choreography remain visually unchanged; all idle events stop instantly on entering non-idle states or under `prefers-reduced-motion`.

## 7. Risks & Assumptions

- **RISK-001**: Idle events could leak into active states if cancellation is incomplete, polluting meaningful state animations. Mitigation: REQ-005/TASK-010 reset the scheduler whenever `!idleEligible`, and TASK-016 applies idle contributions strictly after baselines and only when eligible.
- **RISK-002**: Cumulative drift — repeated events could leave residual intensity/displacement/glow if the blink is applied by mutating the stored live state (`_glowStrength`, rim opacity, emissive intensity) instead of fresh per-frame baselines. Mitigation: PAT-001/PAT-003 require the blink to be a transient multiplier/addend applied from fresh frame baselines, structurally preventing drift (TEST-003/011).
- **RISK-003**: Events firing too often would look busy/nervous rather than calm. Mitigation: conservative min/max delays in `IDLE_FX_CONFIG`, at most one micro-event active at a time, and all values are tunable.
- **RISK-004**: The blink dim could be mistaken for a glitch or a state change. Mitigation: short `blinkDurationMs` (~320 ms), partial dim (`blinkDimFactor`), and a smooth recover envelope keep it subtle and organic.
- **RISK-005**: `setTimeout`-style scheduling would desync with the render clock and keep firing in background tabs. Mitigation: CON-001 mandates delta-accumulated scheduling inside `animate()`.
- **RISK-006**: The current non-listening branch uses an `anyChange` threshold optimized for tiny idle noise; discrete pulse/ripple addends could fail to repaint if the threshold logic is left untouched. Mitigation: TASK-019 explicitly treats active idle events as a change source.
- **RISK-007**: Event-start selection can flicker if the chosen orb/ripple origin is re-derived every frame from progress instead of being latched once. Mitigation: REQ-008/TASK-011 use activation `seq` tokens and cached selections.
- **ASSUMPTION-001**: The `idle` state is the correct and sufficient trigger condition; `warmup`/`error`/lifecycle are intentionally excluded.
- **ASSUMPTION-002**: A uniform-random inter-event delay reads as "unpredictable/organic"; no Poisson or more complex distribution is required for v1.
- **ASSUMPTION-003**: Reusing the existing per-vertex displacement, orb-intensity, glow-strength, and rim-opacity pipelines is sufficient to express all four event kinds; no new geometry, materials, or lights are needed.
- **ASSUMPTION-004**: The state set observable via `sphereStateRef` is `idle/listening/transcribing/thinking/speaking/warmup/error`, and only `idle` enables this feature.

## 8. Related Specifications / Further Reading

- [frontend/animation-easings.js](frontend/animation-easings.js) — pattern this module's pure-function/testing approach mirrors.
- [tests/test_frontend_animation_easings.py](tests/test_frontend_animation_easings.py) — Node-ESM test harness pattern reused by TEST-001…TEST-010.
- [frontend/app.js](frontend/app.js) — the live renderer this plan now explicitly anchors to: orb baseline intensity assignment, lifecycle reset hooks, the listening analyser-driven deformation branch, and the non-listening `proximityPush + idleNoise` branch.
- [plan/feature-sphere-orb-behavior-1.md](plan/feature-sphere-orb-behavior-1.md) — companion plan that shares the orb intensity/colour pipeline the orb-brighten event modulates.
- [plan/feature-sphere-breath-ripple-1.md](plan/feature-sphere-breath-ripple-1.md) and [plan/feature-sphere-voronoi-surface-1.md](plan/feature-sphere-voronoi-surface-1.md) — related future sphere work, but explicitly NOT required for this feature after the current-state review.
- [assets/archived/feature-boot-shutdown-animation-1.md](assets/archived/feature-boot-shutdown-animation-1.md) — lifecycle choreography during which idle expressiveness is suppressed.
