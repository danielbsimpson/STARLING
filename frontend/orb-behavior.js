// ── orb-behavior.js ───────────────────────────────────────────────────────────
// Pure, GPU-free math for the seven orbiting light orbs: state→colour-temperature
// mapping, temperature→RGB ramp, boid-style steering / integration, and chase
// scheduling. Mirrors the pure-function + unit-test convention of
// animation-easings.js. No imports — every function operates on plain numbers
// and {x,y,z} / {r,g,b} objects so it is unit-testable in Node.
//
// Hot-loop callers may pass a reusable `out` object to the vector/colour
// functions to keep per-frame allocation at zero (CON-002); omitting `out`
// keeps the functions pure for testing.

// ── Tunables ────────────────────────────────────────────────────────────────
// All magic numbers for the orb simulation live here so they can be adjusted in
// one place, mirroring the BOOT_CHOREO / SLEEP_CHOREO style in initSphere().
export const ORB_BEHAVIOR_CONFIG = {
  sepRadius: 0.55,        // neighbours closer than this repel each other (world units)
  sepWeight: 1.6,         // strength of the separation (repulsion) steering term
  pathWeight: 2.4,        // strength of the pull toward the analytic orbit target
  shellWeight: 0.8,       // strength of attraction back toward the orbit-radius shell
  maxSteer: 3.0,          // clamp on the steering acceleration magnitude
  posSmoothing: 6.0,      // critically-damped velocity damping rate (1/s)
  idleRadiusMult: 1.0,    // orbit-radius multiplier when idle
  listenRadiusMult: 0.78, // tighter orbits while listening
  speakPulseAmount: 0.18, // fraction the orbit radius pulses with the voice waveform
  thinkJitterAmp: 0.9,    // amplitude of erratic angular/radius jitter while thinking
  chaseProb: 0.004,       // per-frame probability a two-orb chase begins while thinking
  chaseDurationMs: 900,   // how long a chase lasts before the pair rejoins the group
  tempSmoothing: 2.5,     // colour-temperature easing rate (1/s)
  emberSpread: 0.12,      // per-orb temperature offset spread ("embers")
  micDir: { x: 0, y: -0.6, z: 0.8 }, // direction the cluster leans toward while listening
};

// ── State → warmth mapping ──────────────────────────────────────────────────
// Normalised "warmth" 0..1: 0 = cool blue-white (calm), 1 = warm gold (active).
export const ORB_TEMP_BY_STATE = {
  idle: 0.0,
  listening: 0.35,
  transcribing: 0.7,
  thinking: 0.7,
  speaking: 1.0,
  warmup: 0.5,
  error: 1.0,
};

/**
 * Warmth (0..1) for an assistant state. Unknown states fall back to 0 (idle cool).
 * @param {string} state
 * @returns {number}
 */
export function warmthForState(state) {
  return ORB_TEMP_BY_STATE[state] ?? 0.0;
}

// Colour ramp anchors: cool blue-white → cyan → gold (artistic, not Planckian).
const _COOL = { r: 0.78, g: 0.86, b: 1.0 };
const _CYAN = { r: 0.55, g: 0.95, b: 1.0 };
const _GOLD = { r: 1.0, g: 0.82, b: 0.45 };

function _clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function _lerp(a, b, f) {
  return a + (b - a) * f;
}

/**
 * Map a warmth value (plus a per-orb ember offset) to an RGB colour in 0..1 via
 * piecewise-linear interpolation across the cool → cyan → gold anchors.
 * @param {number} warmth   base warmth 0..1
 * @param {number} [ember]  per-orb offset added before clamping
 * @param {{r:number,g:number,b:number}} [out] optional reusable target
 * @returns {{r:number,g:number,b:number}}
 */
export function temperatureToRGB(warmth, ember = 0, out = { r: 0, g: 0, b: 0 }) {
  const w = _clamp01(warmth + ember);
  if (w < 0.5) {
    const f = w / 0.5;
    out.r = _lerp(_COOL.r, _CYAN.r, f);
    out.g = _lerp(_COOL.g, _CYAN.g, f);
    out.b = _lerp(_COOL.b, _CYAN.b, f);
  } else {
    const f = (w - 0.5) / 0.5;
    out.r = _lerp(_CYAN.r, _GOLD.r, f);
    out.g = _lerp(_CYAN.g, _GOLD.g, f);
    out.b = _lerp(_CYAN.b, _GOLD.b, f);
  }
  return out;
}

/**
 * Boid-style steering acceleration for one orb:
 *   (1) path-follow toward its analytic orbit target,
 *   (2) inverse-distance separation from every neighbour within sepRadius,
 *   (3) shell attraction pulling |cur| back toward |target| (the orbit radius).
 * The result magnitude is clamped to cfg.maxSteer. Pure over plain {x,y,z}.
 * @param {{x:number,y:number,z:number}} cur       current orb position
 * @param {{x:number,y:number,z:number}} target    analytic orbit target point
 * @param {Array<{x:number,y:number,z:number}>} neighbors other orb positions
 * @param {typeof ORB_BEHAVIOR_CONFIG} cfg
 * @param {{x:number,y:number,z:number}} [out]     optional reusable target
 * @returns {{x:number,y:number,z:number}} steering acceleration
 */
export function steerOrb(cur, target, neighbors, cfg, out = { x: 0, y: 0, z: 0 }) {
  // (1) Path-follow toward the analytic target.
  let ax = (target.x - cur.x) * cfg.pathWeight;
  let ay = (target.y - cur.y) * cfg.pathWeight;
  let az = (target.z - cur.z) * cfg.pathWeight;

  // (2) Separation: push away from any neighbour inside sepRadius.
  for (let i = 0; i < neighbors.length; i++) {
    const n = neighbors[i];
    const dx = cur.x - n.x;
    const dy = cur.y - n.y;
    const dz = cur.z - n.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 1e-9 && d < cfg.sepRadius) {
      // Stronger the closer they are; normalise direction by dividing by d.
      const push = ((cfg.sepRadius - d) / cfg.sepRadius) * cfg.sepWeight / d;
      ax += dx * push;
      ay += dy * push;
      az += dz * push;
    }
  }

  // (3) Shell attraction: pull the radius toward the analytic orbit radius.
  const curLen = Math.sqrt(cur.x * cur.x + cur.y * cur.y + cur.z * cur.z) || 1e-9;
  const tgtLen = Math.sqrt(target.x * target.x + target.y * target.y + target.z * target.z);
  const shellDelta = (tgtLen - curLen) * cfg.shellWeight;
  ax += (cur.x / curLen) * shellDelta;
  ay += (cur.y / curLen) * shellDelta;
  az += (cur.z / curLen) * shellDelta;

  // Clamp the steering magnitude.
  const mag = Math.sqrt(ax * ax + ay * ay + az * az);
  if (mag > cfg.maxSteer) {
    const s = cfg.maxSteer / mag;
    ax *= s;
    ay *= s;
    az *= s;
  }

  out.x = ax;
  out.y = ay;
  out.z = az;
  return out;
}

/**
 * Advance an orb position by semi-implicit Euler integration with
 * critically-damped velocity smoothing. The steering acceleration carries the
 * pull toward the target (see steerOrb), so this just integrates it stably.
 * Returns inputs unchanged when delta <= 0.
 * @param {{x:number,y:number,z:number}} cur
 * @param {{x:number,y:number,z:number}} vel
 * @param {{x:number,y:number,z:number}} accel
 * @param {number} delta            seconds since last frame
 * @param {number} posSmoothing     velocity damping rate (1/s)
 * @param {{pos:object,vel:object}} [out] optional reusable target
 * @returns {{pos:{x:number,y:number,z:number},vel:{x:number,y:number,z:number}}}
 */
export function integrateOrbPosition(cur, vel, accel, delta, posSmoothing, out) {
  if (out === undefined) out = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
  if (delta <= 0) {
    out.pos.x = cur.x; out.pos.y = cur.y; out.pos.z = cur.z;
    out.vel.x = vel.x; out.vel.y = vel.y; out.vel.z = vel.z;
    return out;
  }
  const damp = Math.exp(-posSmoothing * delta);
  // Apply acceleration, damp the velocity, then advance the position.
  const nvx = (vel.x + accel.x * delta) * damp;
  const nvy = (vel.y + accel.y * delta) * damp;
  const nvz = (vel.z + accel.z * delta) * damp;
  out.vel.x = nvx;
  out.vel.y = nvy;
  out.vel.z = nvz;
  out.pos.x = cur.x + nvx * delta;
  out.pos.y = cur.y + nvy * delta;
  out.pos.z = cur.z + nvz * delta;
  return out;
}

/**
 * Deterministic chase trigger. True when the injectable rng draws below
 * chaseProb (so a stubbed rng makes scheduling fully testable).
 * @param {() => number} [rng]
 * @param {number} [chaseProb]
 * @returns {boolean}
 */
export function shouldStartChase(rng = Math.random, chaseProb = 0) {
  return rng() < chaseProb;
}

/**
 * Pick two distinct indices in [0, n) using an injectable rng.
 * @param {() => number} [rng]
 * @param {number} n
 * @returns {[number, number]}
 */
export function pickChasePair(rng = Math.random, n = 2) {
  const a = Math.floor(rng() * n) % n;
  let b = Math.floor(rng() * (n - 1)) % (n - 1);
  if (b >= a) b += 1;
  return [a, b];
}
