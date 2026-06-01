// ── nebula-bg.js ──────────────────────────────────────────────────────────────
// Isolated procedural nebula background.
// Renders a slow-moving deep-space field into #nebula-canvas using a dedicated,
// throttled WebGL context separate from the sphere renderer.
// All configuration lives in NEBULA_CONFIG (ambient-fx.js); this module has no
// other external dependencies — it reads window.THREE and early-returns safely
// if Three.js or WebGL is unavailable (CON-005).

import { NEBULA_CONFIG, NEBULA_GLSL, shouldRenderFrame } from './ambient-fx.js';

// ── Static vertex shader ───────────────────────────────────────────────────────
// Plain string literal only — no template interpolation (SEC-002).
const _VERT_SHADER = [
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = uv;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}',
].join('\n');

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Initialise the procedural nebula background.
 * Mounts a throttled WebGL render loop on #nebula-canvas.
 * Safe to call unconditionally — exits without side-effects when Three.js or
 * WebGL is unavailable (CON-005).
 *
 * @param {{ getState?: () => string }} [options]
 *   getState — optional callback returning the current assistant state string.
 *   Reserved for a future subtle accent tint; currently unused (off by default).
 */
export function initNebula({ getState } = {}) {
  // CON-005: Guard — Three.js must be present as a global.
  const THREE = window.THREE;
  if (typeof THREE === 'undefined') return;

  const canvas = document.getElementById('nebula-canvas');
  if (!canvas) return;

  // CON-005: Guard — WebGL context must be obtainable.
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  } catch (_err) {
    // WebGL unavailable — CSS background (--bg + .grid-bg) remains visible.
    return;
  }

  renderer.setPixelRatio(NEBULA_CONFIG.pixelRatio);
  // updateStyle = false: CSS controls the display size; we only set the buffer.
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // ── Full-screen quad scene ──────────────────────────────────────────────────
  // An OrthographicCamera(-1,1,1,-1) maps world space directly to clip space,
  // so a PlaneGeometry(2,2) fills the entire canvas without any further scaling.
  const scene  = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    uNebTime:       { value: 0.0 },
    uNebScale:      { value: NEBULA_CONFIG.scale },
    uNebBase:       { value: new THREE.Vector3(
      NEBULA_CONFIG.baseColor.r,
      NEBULA_CONFIG.baseColor.g,
      NEBULA_CONFIG.baseColor.b,
    ) },
    uNebAccent:     { value: new THREE.Vector3(
      NEBULA_CONFIG.accentColor.r,
      NEBULA_CONFIG.accentColor.g,
      NEBULA_CONFIG.accentColor.b,
    ) },
    uNebAccent2:    { value: new THREE.Vector3(
      NEBULA_CONFIG.accent2Color.r,
      NEBULA_CONFIG.accent2Color.g,
      NEBULA_CONFIG.accent2Color.b,
    ) },
    uNebBrightness: { value: NEBULA_CONFIG.brightness },
    uNebAspect:     { value: window.innerWidth / Math.max(1, window.innerHeight) },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader:   _VERT_SHADER,
    fragmentShader: NEBULA_GLSL,
    uniforms,
    depthWrite: false,
  });

  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  // ── Reduced-motion: one static frame, no animation (CON-003) ───────────────
  const prefersReduced =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReduced) {
    renderer.render(scene, camera);
    return;
  }

  // ── Throttled animation loop (REQ-006, CON-002) ────────────────────────────
  // lastRenderMs tracks when we last rendered (for the throttle predicate).
  // Initialise to -throttleMs so the very first rAF call renders immediately.
  let lastRenderMs = -NEBULA_CONFIG.throttleMs;

  function frame(now) {
    requestAnimationFrame(frame);

    // REQ-006: pause when the document tab is not visible.
    if (document.hidden) return;

    if (!shouldRenderFrame(lastRenderMs, now, NEBULA_CONFIG.throttleMs)) return;

    // Advance the nebula time uniform proportionally to elapsed wall time.
    const elapsed    = lastRenderMs < 0 ? 0 : (now - lastRenderMs) * 0.001; // seconds
    lastRenderMs     = now;
    uniforms.uNebTime.value += elapsed * NEBULA_CONFIG.driftSpeed;

    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);

  // ── Resize handler ─────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    uniforms.uNebAspect.value = window.innerWidth / Math.max(1, window.innerHeight);
  });

  // ── Visibility change — reset lastRenderMs to avoid time jumps (REQ-006) ──
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Reset so next frame treats elapsed as 0 rather than hours.
      lastRenderMs = -NEBULA_CONFIG.throttleMs;
    }
  });
}
