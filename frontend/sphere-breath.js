// ── sphere-breath.js ──────────────────────────────────────────────────────────
// Pure-function module for the sphere breath cycle and directional mic-impact
// ripple. All functions operate on numbers and plain {x,y,z} objects with no
// Three.js or DOM dependencies, making them fully unit-testable in Node.js.
// See plan/feature-sphere-breath-ripple-1.md for the design rationale.

/**
 * Tunables for the breath cycle and directional mic-impact ripple.
 * All values are grouped here (GUD-001) — adjust freely without touching animate().
 */
export const BREATH_CONFIG = {
  breathHz:            0.25,   // breath cycle frequency (~4 s period)
  idleAmp:             0.012,  // radial scale delta in idle/silent state
  activeAmp:           0.022,  // radial scale delta in active states (listening/thinking/speaking…)
  ampSmoothing:        1.2,    // exp-smoothing rate for breath amplitude across state transitions
  rippleDepth:         0.06,   // maximum inward radial delta for the mic-impact ripple
  rippleFalloff:       2.2,    // angular falloff power (higher = narrower lobe toward mic)
  rippleGainSmoothing: 6.0,    // exp-smoothing rate for ripple gain (audio amplitude)
  micDir: { x: 0, y: -0.6, z: 0.8 }, // unit-ish direction toward the microphone
};

/**
 * Returns the target breath amplitude for the given sphere state string.
 * Active states breathe slightly deeper; all other states use the idle amplitude.
 * @param {string} state
 * @returns {number}
 */
export function breathAmplitudeForState(state) {
  switch (state) {
    case 'listening':
    case 'thinking':
    case 'transcribing':
    case 'speaking':
    case 'warmup':
      return BREATH_CONFIG.activeAmp;
    default:
      return BREATH_CONFIG.idleAmp;
  }
}

/**
 * Uniform radial scale delta applied to every vertex this frame.
 * Returns a value in [-amplitude, +amplitude].
 * @param {number} phase     current breath phase in radians
 * @param {number} amplitude current (eased) amplitude scalar
 * @returns {number}
 */
export function breathDisplacement(phase, amplitude) {
  return Math.sin(phase) * amplitude;
}

/**
 * Advance the breath phase by one frame, wrapping to [0, 2π).
 * Returns `phase` unchanged when delta ≤ 0.
 * @param {number} phase    current phase (radians)
 * @param {number} breathHz frequency in Hz
 * @param {number} delta    frame time in seconds
 * @returns {number}
 */
export function advanceBreathPhase(phase, breathHz, delta) {
  if (delta <= 0) return phase;
  return (phase + 2 * Math.PI * breathHz * delta) % (2 * Math.PI);
}

// ── Internal vector helpers ───────────────────────────────────────────────────

function _dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function _lenSq(v) {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-vertex weight for the directional mic-impact ripple.
 * Vertices aligned with `micDir` receive weight ≈ 1 (maximum inward push);
 * vertices on the far side receive 0. Result is always in [0, 1].
 *
 * @param {{x:number,y:number,z:number}} vertexDir  vertex position (normalised internally)
 * @param {{x:number,y:number,z:number}} micDir     microphone direction (normalised internally)
 * @param {number} falloff  angular falloff power (BREATH_CONFIG.rippleFalloff)
 * @returns {number}
 */
export function rippleWeight(vertexDir, micDir, falloff) {
  const vLen = Math.sqrt(_lenSq(vertexDir));
  const mLen = Math.sqrt(_lenSq(micDir));
  if (vLen === 0 || mLen === 0) return 0;
  const cosAngle = _dot(vertexDir, micDir) / (vLen * mLen);
  return Math.pow(Math.max(0, cosAngle), falloff);
}

/**
 * Per-vertex inward radial displacement from the mic-impact ripple.
 * Result is ≤ 0 (inward) for non-negative inputs.
 *
 * @param {number} weight      precomputed rippleWeight for this vertex  (0..1)
 * @param {number} audioAmp    normalised audio amplitude this frame     (0..1)
 * @param {number} gain        smoothed ripple gain scalar               (0..1)
 * @param {number} rippleDepth maximum inward delta (BREATH_CONFIG.rippleDepth)
 * @returns {number}
 */
export function rippleDisplacement(weight, audioAmp, gain, rippleDepth) {
  return -(weight * audioAmp * gain * rippleDepth);
}

/**
 * Frame-rate-independent exponential smoothing toward a target value.
 * Returns `current` unchanged when `delta ≤ 0`.
 *
 * @param {number} current  current value
 * @param {number} target   target value
 * @param {number} rate     convergence rate (units: 1/second)
 * @param {number} delta    frame time in seconds
 * @returns {number}
 */
export function smoothToward(current, target, rate, delta) {
  if (delta <= 0) return current;
  return target + (current - target) * Math.exp(-rate * delta);
}
