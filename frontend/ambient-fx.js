// ── ambient-fx.js ─────────────────────────────────────────────────────────────
// Pure-function module: state → glow/bloom/nebula parameter mapping and frame
// helpers. No external dependencies; all tunables live in named config objects
// mirroring the BOOT_CHOREO / SLEEP_CHOREO style of app.js.
// All GLSL is a static string literal — no template interpolation (SEC-002).
// Mirrors the structure and unit-testing approach of animation-easings.js.

// ── Glow / bloom tunables ──────────────────────────────────────────────────────

/** Glow and bloom tunables. Adjust values here without touching animation logic. */
export const GLOW_CONFIG = {
  idleColor:           { r: 0.36, g: 0.55, b: 1.00 }, // cool blue  — resting state
  listenColor:         { r: 0.40, g: 0.70, b: 1.00 }, // cyan-blue  — listening
  thinkColor:          { r: 0.45, g: 0.85, b: 0.65 }, // teal-green — thinking / transcribing
  speakColor:          { r: 1.00, g: 0.62, b: 0.20 }, // warm amber — speaking
  bloomStrengthIdle:   0.55,  // bloom intensity at idle
  bloomStrengthActive: 1.05,  // bloom intensity during active interaction states
  bloomRadius:         0.95,  // UnrealBloomPass scatter radius — wide, soft falloff
  bloomThreshold:      0.15,  // luminance threshold — only bright pixels bloom
  colorSmoothing:      3.0,   // colour ease rate (per-second exponential; higher = faster)
  strengthSmoothing:   2.5,   // bloom-strength ease rate (per-second exponential)
};

// ── State → glow colour ────────────────────────────────────────────────────────

/**
 * Returns a fresh {r,g,b} colour anchor for the given assistant state.
 * Unmapped states fall back to the idle cool-blue anchor.
 * @param {string} state
 * @returns {{ r: number, g: number, b: number }}
 */
export function glowColorForState(state) {
  switch (state) {
    case 'listening':    return { ...GLOW_CONFIG.listenColor };
    case 'thinking':     return { ...GLOW_CONFIG.thinkColor };
    case 'transcribing': return { ...GLOW_CONFIG.thinkColor };  // maps to think colour
    case 'speaking':     return { ...GLOW_CONFIG.speakColor };
    case 'warmup':       return { ...GLOW_CONFIG.listenColor }; // warmup → listen colour
    case 'error':        return { ...GLOW_CONFIG.speakColor };  // error → speak/amber
    default:             return { ...GLOW_CONFIG.idleColor };
  }
}

// ── State → bloom strength ─────────────────────────────────────────────────────

/**
 * Returns the target bloom strength for the given assistant state.
 * Active interaction states use a higher strength; all others use the idle value.
 * @param {string} state
 * @returns {number}
 */
export function bloomStrengthForState(state) {
  switch (state) {
    case 'listening':
    case 'thinking':
    case 'transcribing':
    case 'speaking':
      return GLOW_CONFIG.bloomStrengthActive;
    default:
      return GLOW_CONFIG.bloomStrengthIdle;
  }
}

// ── Frame-rate-independent smoothing ──────────────────────────────────────────

/**
 * Frame-rate-independent exponential smoothing toward a target scalar.
 * Uses the formula: target + (current − target) × exp(−rate × delta)
 * @param {number} current  current value
 * @param {number} target   target value
 * @param {number} rate     smoothing rate per second (higher = snappier)
 * @param {number} delta    elapsed seconds; returns current unchanged when ≤ 0
 * @returns {number}
 */
export function smoothToward(current, target, rate, delta) {
  if (delta <= 0) return current;
  return target + (current - target) * Math.exp(-rate * delta);
}

/**
 * Frame-rate-independent exponential smoothing of an {r,g,b} colour toward a target.
 * Mutates `cur` in place for efficiency and also returns it.
 * @param {{ r: number, g: number, b: number }} cur    mutated in place
 * @param {{ r: number, g: number, b: number }} target
 * @param {number} rate
 * @param {number} delta
 * @returns {{ r: number, g: number, b: number }}
 */
export function smoothColor(cur, target, rate, delta) {
  cur.r = smoothToward(cur.r, target.r, rate, delta);
  cur.g = smoothToward(cur.g, target.g, rate, delta);
  cur.b = smoothToward(cur.b, target.b, rate, delta);
  return cur;
}

// ── Nebula background tunables ─────────────────────────────────────────────────

/** Nebula background tunables. Adjust here without touching rendering logic. */
export const NEBULA_CONFIG = {
  driftSpeed:   0.012,                          // time-uniform multiplier — very slow drift
  scale:        3.0,                             // UV scale — larger value = zoomed-in field
  baseColor:    { r: 0.008, g: 0.012, b: 0.028 }, // near-black deep-space base tone
  accentColor:  { r: 0.10,  g: 0.16,  b: 0.42 },  // luminous blue cloud veins
  accent2Color: { r: 0.34,  g: 0.10,  b: 0.40 },  // magenta/violet secondary nebula tone
  brightness:   1.0,                             // overall luminance multiplier
  throttleMs:   33,                              // render interval in ms (~30 fps)
  pixelRatio:   1.0,                             // internal resolution scale (≤1 is cheaper)
};

// ── Frame throttle predicate ───────────────────────────────────────────────────

/**
 * Returns true when enough time has elapsed since the last rendered frame.
 * Deterministic and side-effect-free — safe to unit-test in Node.
 * @param {number} lastMs      timestamp of the last rendered frame (ms)
 * @param {number} nowMs       current timestamp (ms)
 * @param {number} throttleMs  minimum interval between frames (ms)
 * @returns {boolean}
 */
export function shouldRenderFrame(lastMs, nowMs, throttleMs) {
  return (nowMs - lastMs) >= throttleMs;
}

// ── Nebula fragment GLSL ───────────────────────────────────────────────────────
// Static string — NO template-literal interpolation; array-join over plain
// string literals only (SEC-002 static-source requirement).
// Uniforms: uNebTime (float), uNebScale (float), uNebBase (vec3),
//           uNebAccent (vec3), uNebAccent2 (vec3), uNebBrightness (float),
//           uNebAspect (float).
// Varying:  vUv (vec2) — set by the companion vertex shader in nebula-bg.js.

export const NEBULA_GLSL = [
  'precision highp float;',
  'uniform float uNebTime;',
  'uniform float uNebScale;',
  'uniform vec3  uNebBase;',
  'uniform vec3  uNebAccent;',
  'uniform vec3  uNebAccent2;',
  'uniform float uNebBrightness;',
  'uniform float uNebAspect;',
  'varying vec2  vUv;',
  '',
  '// Pseudo-random hash from a 2-D point.',
  'float hash(vec2 p) {',
  '  p = fract(p * vec2(127.1, 311.7));',
  '  p += dot(p, p + 17.5);',
  '  return fract(p.x * p.y);',
  '}',
  '',
  '// Smooth value noise — bilinear interpolation of four hashed corners.',
  'float valueNoise(vec2 p) {',
  '  vec2 i = floor(p);',
  '  vec2 f = fract(p);',
  '  vec2 u = f * f * (3.0 - 2.0 * f);',
  '  return mix(',
  '    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),',
  '    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),',
  '    u.y',
  '  );',
  '}',
  '',
  '// 5-octave fractional Brownian motion — produces layered cloud structure.',
  'float fbm(vec2 p) {',
  '  float v = 0.0;',
  '  float a = 0.5;',
  '  vec2  shift = vec2(1.3, 0.7);',
  '  for (int i = 0; i < 5; i++) {',
  '    v += a * valueNoise(p);',
  '    p  = p * 2.1 + shift;',
  '    a *= 0.5;',
  '  }',
  '  return v;',
  '}',
  '',
  '// Sparse twinkling starfield — bright points on a hashed grid.',
  '// Returns an additive white contribution; most cells contribute nothing.',
  'float starfield(vec2 uv, float density, float t) {',
  '  vec2  g  = uv * density;',
  '  vec2  i  = floor(g);',
  '  vec2  f  = fract(g) - 0.5;',
  '  float h  = hash(i);',
  '  // Only a small fraction of cells host a star.',
  '  float present = step(0.999, h);',
  '  // Random sub-cell offset so stars are not grid-aligned.',
  '  vec2  off = vec2(hash(i + 3.7), hash(i + 9.1)) - 0.5;',
  '  float d   = length(f - off * 0.7);',
  '  // Tight point falloff -> crisp star.',
  '  float star = present * smoothstep(0.06, 0.0, d);',
  '  // Gentle per-star twinkle.',
  '  float tw   = 0.6 + 0.4 * sin(t * 2.2 + h * 40.0);',
  '  return star * tw;',
  '}',
  '',
  'void main() {',
  '  // Aspect-correct coordinates so clouds/stars are not stretched.',
  '  vec2  p     = vec2((vUv.x - 0.5) * uNebAspect, vUv.y - 0.5);',
  '  vec2  uv    = p * uNebScale;',
  '  float t     = uNebTime;',
  '  // Two fbm layers drifting slowly in orthogonal directions for a fluid feel.',
  '  float n1    = fbm(uv + vec2(t * 0.11,  t * 0.07));',
  '  float n2    = fbm(uv + vec2(-t * 0.08, t * 0.13) + vec2(3.1, 1.7));',
  '  float field = mix(n1, n2, 0.45);',
  '  // A third, larger-scale layer selects between the two accent hues so the',
  '  // nebula reads as distinct coloured regions rather than one flat tint.',
  '  float hueMix = fbm(uv * 0.5 + vec2(t * 0.05, -t * 0.04));',
  '  vec3  cloudHue = mix(uNebAccent, uNebAccent2, smoothstep(0.35, 0.75, hueMix));',
  '  // Soft cloud body plus brighter condensed cores for depth.',
  '  float clouds = smoothstep(0.30, 0.85, field);',
  '  float cores  = pow(smoothstep(0.55, 0.95, field), 3.0);',
  '  vec3  col    = uNebBase;',
  '  col += cloudHue * clouds * 0.9;',
  '  col += cloudHue * cores * 1.4;',
  '  // Layered starfield at two densities for parallax-like depth.',
  '  float stars = starfield(p, 90.0, t) + starfield(p + 5.0, 150.0, t * 0.7) * 0.7;',
  '  col += vec3(stars);',
  '  col *= uNebBrightness;',
  '  gl_FragColor = vec4(col, 1.0);',
  '}',
].join('\n');
