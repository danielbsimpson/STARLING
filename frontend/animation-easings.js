// ── animation-easings.js ──────────────────────────────────────────────────────
// Deterministic easing functions for the sphere lifecycle choreography.
// Each accepts t in [0,1] and returns a value in [0,1] (easeOutBack may
// slightly overshoot beyond 1 near the end — that overshoot is intentional).
// Pure functions, no external dependencies.

/** Decelerating cubic — fast start, gentle settle. */
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Accelerating cubic — gentle start, fast finish. */
export function easeInCubic(t) {
  return t * t * t;
}

/** Symmetric quadratic ease — smooth in and out. */
export function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Decelerating ease with a slight overshoot past 1 before settling.
 * @param {number} t          progress in [0,1]
 * @param {number} overshoot  back-overshoot constant (default 1.70158)
 */
export function easeOutBack(t, overshoot = 1.70158) {
  const c1 = overshoot;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Sinusoidal ease in and out — calmest, dreamiest curve. */
export function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}
