// ── sphere-voronoi.js ─────────────────────────────────────────────────────────
// "Bioluminescent skin" surface effect: dark polygonal cells separated by thin
// glowing edges that pulse. The pattern slowly drifts ("breathing") and the
// edge-pulse rate is tied to the assistant's state. Implemented by injecting
// custom GLSL into the stock MeshPhongMaterial via onBeforeCompile so the seven
// orbiting PointLights still shade the surface (REQ-011); the Voronoi layer only
// adds emissive radiance.
//
// All non-GLSL math is pure / exported for Node unit testing, mirroring
// animation-easings.js. All GLSL is assembled from fixed string literals only
// (SEC-002) — no interpolation of any runtime/user/LLM data.

/** Edge-pulse rate (Hz) per sphere state — slow when calm, fast when thinking. */
export const PULSE_RATE_BY_STATE = {
  idle:         0.18,
  listening:    0.55,
  speaking:     0.70,
  thinking:     1.60,
  transcribing: 1.60,
  warmup:       0.90,
  error:        2.20,
};

/**
 * Pulse rate for a state, falling back to the calm idle rate for any unknown
 * state (ASSUMPTION-003).
 * @param {string} state
 * @returns {number} rate in Hz
 */
export function pulseRateForState(state) {
  return PULSE_RATE_BY_STATE[state] ?? PULSE_RATE_BY_STATE.idle;
}

/**
 * Frame-rate-independent exponential smoothing toward a target.
 * Returns `current` unchanged when `delta <= 0`.
 * @param {number} current
 * @param {number} target
 * @param {number} rate    smoothing rate (1/seconds)
 * @param {number} delta   seconds since last frame
 * @returns {number}
 */
export function smoothToward(current, target, rate, delta) {
  if (!(delta > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-rate * delta));
}

/**
 * Advance a pulse phase by `rateHz` cycles/second over `delta` seconds, wrapped
 * into [0, 2π).
 * @param {number} phase   current phase (radians)
 * @param {number} rateHz  pulse rate in Hz
 * @param {number} delta   seconds since last frame
 * @returns {number} phase in [0, 2π)
 */
export function advancePulsePhase(phase, rateHz, delta) {
  const TWO_PI = Math.PI * 2;
  let next = (phase + TWO_PI * rateHz * delta) % TWO_PI;
  if (next < 0) next += TWO_PI;
  return next;
}

/** Grouped numeric tuning for the Voronoi effect (GUD-001). */
export const VORONOI_CONFIG = {
  cellDensity:    7.0,   // sampling scale → number of cells across the sphere
  edgeSharpness: 14.0,   // pow exponent on the edge band → line thinness
  edgeWidth:      0.06,  // smoothstep width of the glowing border
  glowBase:       0.35,  // baseline emissive multiplier
  glowPulseAmount:0.55,  // fraction of glow that pulses with the phase
  driftSpeed:     0.05,  // how fast the pattern "breathes" over time
  rateSmoothing:  1.5,   // smoothing rate for state→pulse-rate transitions
  colorSmoothing: 4.0,   // (reserved) smoothing rate for glow colour easing
};

// 3D cellular/Voronoi GLSL — a fixed concatenation of string literals only
// (SEC-002). voronoiEdge(p) returns 0..1: ~0 in cell interiors, ~1 on the thin
// borders. References the uVorConfig uniform (declared in the injected header)
// for the smoothstep edge width.
export const VORONOI_GLSL_COMMON = [
  'float vorHash(vec3 p) {',
  '  p = fract(p * 0.3183099 + 0.1);',
  '  p *= 17.0;',
  '  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));',
  '}',
  'vec3 vorHash3(vec3 p) {',
  '  return vec3(',
  '    vorHash(p + vec3(0.0, 1.0, 2.0)),',
  '    vorHash(p + vec3(3.0, 4.0, 5.0)),',
  '    vorHash(p + vec3(6.0, 7.0, 8.0)));',
  '}',
  'float voronoiEdge(vec3 x) {',
  '  vec3 pc = floor(x);',
  '  vec3 f  = fract(x);',
  '  float f1 = 8.0;',
  '  float f2 = 8.0;',
  '  for (int k = -1; k <= 1; k++)',
  '  for (int j = -1; j <= 1; j++)',
  '  for (int i = -1; i <= 1; i++) {',
  '    vec3 g = vec3(float(i), float(j), float(k));',
  '    vec3 o = vorHash3(pc + g);',
  '    vec3 r = g + o - f;',
  '    float d = dot(r, r);',
  '    if (d < f1) { f2 = f1; f1 = d; }',
  '    else if (d < f2) { f2 = d; }',
  '  }',
  '  float edge = sqrt(f2) - sqrt(f1);',
  '  return 1.0 - smoothstep(0.0, uVorConfig.z, edge);',
  '}',
].join('\n');

// Fragment header injected after `#include <common>`: uniform + varying decls
// plus the Voronoi GLSL. Declared before voronoiEdge uses uVorConfig.
const VORONOI_FRAG_HEADER = [
  'uniform float uVorTime;',
  'uniform float uVorGlowIntensity;',
  'uniform vec3  uVorGlowColor;',
  'uniform vec4  uVorConfig;',
  'varying vec3  vVorPos;',
  VORONOI_GLSL_COMMON,
].join('\n');

// Emissive contribution appended after `#include <emissivemap_fragment>`.
const VORONOI_EMISSIVE_GLSL = [
  'float vorBand = voronoiEdge(vVorPos * uVorConfig.x + vec3(0.0, uVorTime, 0.0));',
  'float vorGlow = pow(clamp(vorBand, 0.0, 1.0), uVorConfig.y);',
  'totalEmissiveRadiance += uVorGlowColor * vorGlow * uVorGlowIntensity;',
].join('\n');

/**
 * Build the Voronoi surface effect conforming to the surface-effect interface.
 * @param {object} THREE  the global THREE namespace
 * @param {{sphereGeo: object, baseColor: number}} ctx
 * @returns {{id: string, material: object, update: function, dispose: function}}
 */
export function buildVoronoiEffect(THREE, ctx) {
  const cfg = VORONOI_CONFIG;

  const material = new THREE.MeshPhongMaterial({
    color:             ctx.baseColor ?? 0x060606,
    specular:          0xaaaaaa,
    shininess:         52,
    emissive:          0x0a0a0a,
    emissiveIntensity: 1.0,
  });

  // Uniforms built once and reused every frame (no per-frame allocation).
  const uniforms = {
    uVorTime:          { value: 0 },
    uVorPulse:         { value: 0 },
    uVorGlowColor:     { value: new THREE.Color(0x66ccff) },
    uVorGlowIntensity: { value: cfg.glowBase },
    uVorConfig:        { value: new THREE.Vector4(
      cfg.cellDensity, cfg.edgeSharpness, cfg.edgeWidth, cfg.glowBase,
    ) },
  };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uVorTime          = uniforms.uVorTime;
    shader.uniforms.uVorGlowIntensity = uniforms.uVorGlowIntensity;
    shader.uniforms.uVorGlowColor     = uniforms.uVorGlowColor;
    shader.uniforms.uVorConfig        = uniforms.uVorConfig;

    // Pass object-space position so cells rotate WITH the sphere (RISK-007).
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVorPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vVorPos = position;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + VORONOI_FRAG_HEADER)
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' + VORONOI_EMISSIVE_GLSL);
  };
  // Stable cache key prevents per-frame recompilation.
  material.customProgramCacheKey = () => 'starling-voronoi-v1';

  // Internal eased pulse rate (Hz), starting calm.
  let _rate = pulseRateForState('idle');

  return {
    id: 'voronoi',
    material,
    update(frame) {
      const targetRate = frame.lifecycleActive
        ? pulseRateForState('idle')
        : pulseRateForState(frame.state);
      _rate = smoothToward(_rate, targetRate, cfg.rateSmoothing, frame.delta);

      if (!frame.prefersReducedMotion) {
        uniforms.uVorTime.value += frame.delta * cfg.driftSpeed;
        uniforms.uVorPulse.value = advancePulsePhase(
          uniforms.uVorPulse.value, _rate, frame.delta,
        );
      }
      if (frame.orbColorTarget) {
        uniforms.uVorGlowColor.value.copy(frame.orbColorTarget);
      }
      // Pulse baked into intensity (CPU) so the shader stays a single MAD.
      const pulse01 = 0.5 + 0.5 * Math.sin(uniforms.uVorPulse.value);
      const swing   = (1 - cfg.glowPulseAmount) + cfg.glowPulseAmount * pulse01;
      const fade    = frame.lifecycleActive ? frame.orbOpacity : 1.0;
      uniforms.uVorGlowIntensity.value = cfg.glowBase * swing * fade;
    },
    dispose() {
      material.dispose();
    },
  };
}
