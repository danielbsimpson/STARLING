// ── sphere-liquid-metal.js ────────────────────────────────────────────────────
// "Mercury surface" effect: a custom ShaderMaterial that makes the sphere look
// like reflective liquid metal. Ripples propagate outward from the poles while
// speaking, and surface displacement reacts to audio amplitude from the shared
// analyser. A raw ShaderMaterial bypasses Three.js light uniforms, so the seven
// orb positions/colours are passed in as uniforms and the fragment shader
// reflects them via a fresnel + orb-specular model (REQ-015).
//
// All non-GLSL math is pure / exported for Node unit testing. All GLSL is
// assembled from fixed string literals only (SEC-002).

/** Number of orbiting light orbs reflected by the metal surface. */
export const LIQUID_ORB_COUNT = 7;

/** Grouped numeric tuning for the Liquid Metal effect (GUD-001). */
export const LIQUID_CONFIG = {
  rippleSpeed:      2.4,   // angular speed of the pole-originating ripples
  rippleWavelength: 6.0,   // spatial frequency of the ripples
  poleRippleAmp:    0.06,  // peak radial displacement of a ripple
  audioReactivity:  1.4,   // how strongly audio amplitude drives ripples
  fresnelPower:     2.5,   // rim-light falloff exponent
  metalTint: { r: 0.70, g: 0.75, b: 0.82 }, // cool mercury base colour
  ampSmoothing:     6.0,   // smoothing rate for audio amplitude
  speakRampSmoothing: 4.0, // smoothing rate for the speak on/off ramp
};

/**
 * Distance from the nearest pole for a normalized y coordinate.
 * 0 at a pole (y = ±1), 1 at the equator (y = 0).
 * @param {number} normalizedY  y component of the unit surface normal
 * @returns {number}
 */
export function poleDistance(normalizedY) {
  return 1 - Math.abs(normalizedY);
}

/**
 * Radial ripple displacement at a point — the CPU twin of the vertex shader's
 * ripple term. Zero whenever there is no audio or the surface is not speaking.
 * @param {number} distFromPole  poleDistance() result (0..1)
 * @param {number} time          seconds
 * @param {number} audioAmp      smoothed audio amplitude (0..1)
 * @param {number} speakFactor   speaking ramp (0..1)
 * @param {object} cfg           a LIQUID_CONFIG-shaped object
 * @returns {number}
 */
export function rippleOffset(distFromPole, time, audioAmp, speakFactor, cfg) {
  return Math.sin(distFromPole * cfg.rippleWavelength - time * cfg.rippleSpeed)
    * cfg.poleRippleAmp
    * (audioAmp * cfg.audioReactivity)
    * speakFactor;
}

/**
 * Mean normalized amplitude over a frequency-bin array. Returns 0 for null /
 * empty input.
 * @param {?(Uint8Array|number[])} data
 * @returns {number} mean in [0, 1]
 */
export function audioAmplitudeFromBins(data) {
  if (!data || data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] / 255;
  return sum / data.length;
}

// Vertex shader — pole-originating ripple displacement along the normal, with
// world-space varyings for the fragment lighting model. Fixed literals (SEC-002).
export const LIQUID_VERTEX_GLSL = [
  'uniform float uTime;',
  'uniform float uAudioAmp;',
  'uniform float uSpeakFactor;',
  'uniform float uWavelength;',
  'uniform float uSpeed;',
  'uniform float uPoleAmp;',
  'varying vec3  vWorldPos;',
  'varying vec3  vWorldNormal;',
  'void main() {',
  '  vec3 n = normalize(position);',
  '  float poleDist = 1.0 - abs(n.y);',
  '  float disp = sin(poleDist * uWavelength - uTime * uSpeed)',
  '             * uPoleAmp * uAudioAmp * uSpeakFactor;',
  '  vec3 displaced = position + normal * disp;',
  '  vec4 worldPos  = modelMatrix * vec4(displaced, 1.0);',
  '  vWorldPos    = worldPos.xyz;',
  '  vWorldNormal = normalize(mat3(modelMatrix) * normal);',
  '  gl_Position  = projectionMatrix * viewMatrix * worldPos;',
  '}',
].join('\n');

// Fragment shader — mercury look: fresnel rim + orb-lit specular/diffuse summed
// over the seven orbs + metal tint, modulated by uIntensity. Fixed literals.
export const LIQUID_FRAGMENT_GLSL = [
  'uniform float uFresnelPower;',
  'uniform vec3  uMetalTint;',
  'uniform float uIntensity;',
  'uniform vec3  uOrbPos[7];',
  'uniform vec3  uOrbColor[7];',
  'varying vec3  vWorldPos;',
  'varying vec3  vWorldNormal;',
  'void main() {',
  '  vec3 N = normalize(vWorldNormal);',
  '  vec3 V = normalize(cameraPosition - vWorldPos);',
  '  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uFresnelPower);',
  '  vec3 lit = vec3(0.0);',
  '  for (int i = 0; i < 7; i++) {',
  '    vec3 L = normalize(uOrbPos[i] - vWorldPos);',
  '    vec3 H = normalize(L + V);',
  '    float spec = pow(max(dot(N, H), 0.0), 64.0);',
  '    float diff = max(dot(N, L), 0.0);',
  '    lit += uOrbColor[i] * (spec + diff * 0.15);',
  '  }',
  '  vec3 col = uMetalTint * (0.12 + 0.9 * lit) + uMetalTint * fres * 0.6;',
  '  gl_FragColor = vec4(col * uIntensity, 1.0);',
  '}',
].join('\n');

/**
 * Build the Liquid Metal surface effect conforming to the surface-effect
 * interface.
 * @param {object} THREE  the global THREE namespace
 * @param {{sphereGeo: object, baseColor: number}} ctx
 * @returns {{id: string, material: object, update: function, dispose: function}}
 */
export function buildLiquidMetalEffect(THREE, ctx) {
  const cfg = LIQUID_CONFIG;

  // Preallocated uniform arrays — filled in place each frame (no allocation).
  const orbPos   = [];
  const orbColor = [];
  for (let i = 0; i < LIQUID_ORB_COUNT; i++) {
    orbPos.push(new THREE.Vector3());
    orbColor.push(new THREE.Color(0xffffff));
  }

  const uniforms = {
    uTime:         { value: 0 },
    uAudioAmp:     { value: 0 },
    uSpeakFactor:  { value: 0 },
    uFresnelPower: { value: cfg.fresnelPower },
    uMetalTint:    { value: new THREE.Color(cfg.metalTint.r, cfg.metalTint.g, cfg.metalTint.b) },
    uIntensity:    { value: 1 },
    uOrbPos:       { value: orbPos },
    uOrbColor:     { value: orbColor },
    uWavelength:   { value: cfg.rippleWavelength },
    uSpeed:        { value: cfg.rippleSpeed },
    uPoleAmp:      { value: cfg.poleRippleAmp * cfg.audioReactivity },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader:   LIQUID_VERTEX_GLSL,
    fragmentShader: LIQUID_FRAGMENT_GLSL,
    uniforms,
  });

  // Internal smoothed scalars.
  let _amp   = 0;
  let _speak = 0;

  function _smooth(current, target, rate, delta) {
    if (!(delta > 0)) return current;
    return current + (target - current) * (1 - Math.exp(-rate * delta));
  }

  return {
    id: 'liquid-metal',
    material,
    update(frame) {
      // Single analyser read per frame (RISK-008): reuse the shared buffer.
      let rawAmp = 0;
      const an = frame.analyser;
      if (an && an.an && an.data && typeof an.an.getByteFrequencyData === 'function') {
        an.an.getByteFrequencyData(an.data);
        rawAmp = audioAmplitudeFromBins(an.data);
      }
      _amp = _smooth(_amp, rawAmp, cfg.ampSmoothing, frame.delta);
      const speakTarget = frame.state === 'speaking' ? 1 : 0;
      _speak = _smooth(_speak, speakTarget, cfg.speakRampSmoothing, frame.delta);

      uniforms.uAudioAmp.value    = _amp;
      uniforms.uSpeakFactor.value = _speak;
      if (!frame.prefersReducedMotion) {
        uniforms.uTime.value += frame.delta;
      }
      uniforms.uIntensity.value = frame.lifecycleActive ? frame.orbOpacity : 1.0;

      // Reflect the live orbs (REQ-015). Voronoi ignores frame.orbs.
      const orbs = frame.orbs || [];
      for (let i = 0; i < LIQUID_ORB_COUNT; i++) {
        const orb = orbs[i];
        if (!orb) continue;
        const p = orb.light ? orb.light.position
          : (orb.mesh ? orb.mesh.position : null);
        if (p) orbPos[i].set(p.x, p.y, p.z);
        if (orb.color) orbColor[i].copy(orb.color);
      }
    },
    dispose() {
      material.dispose();
    },
  };
}
