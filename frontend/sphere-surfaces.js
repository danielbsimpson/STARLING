// ── sphere-surfaces.js ────────────────────────────────────────────────────────
// Pluggable surface-effect framework for the living sphere. Defines the effect
// interface contract, the menu registry, the allow-list of valid effect ids,
// and validated localStorage persistence helpers. Pure / DOM-free so the
// non-rendering logic is unit-testable in Node, mirroring animation-easings.js.
//
// ── Effect interface ──────────────────────────────────────────────────────────
// A surface effect is produced by a builder function:
//
//   build(THREE, ctx) -> { id, material, update(frame), dispose() }
//
//   ctx   = { sphereGeo, baseColor }
//             sphereGeo  – the shared THREE.SphereGeometry (CPU vertex
//                          deformation is applied to this by animate()).
//             baseColor  – hex base colour for the dark sphere body.
//
//   frame = { state, delta, t, orbColorTarget, lifecycleActive,
//             orbOpacity, prefersReducedMotion, analyser, orbs }
//             state                – current sphere state string.
//             delta                – seconds since the previous frame.
//             t                    – absolute time in seconds.
//             orbColorTarget       – THREE.Color the orbs are easing toward.
//             lifecycleActive      – true during boot/shutdown/sleep/wake.
//             orbOpacity           – current orb fade factor (0..1).
//             prefersReducedMotion – freeze all time-varying motion when true.
//             analyser             – { an, data } shared audio analyser ref.
//             orbs                 – live orb array (positions + colours).
//
//   material  – the THREE material assigned to the sphere mesh.
//   update(frame) – called once per frame to refresh uniforms (no allocation).
//   dispose()     – release GPU resources for this effect's material.

/** Ordered allow-list of valid surface effect ids (SEC-002 guard). */
export const SURFACE_IDS = ['voronoi', 'liquid-metal', 'solid-black'];

/** Default effect when nothing valid is stored. */
export const DEFAULT_SURFACE_ID = 'voronoi';

/** localStorage key for the persisted selection. */
export const SURFACE_STORAGE_KEY = 'starling_sphere_surface';

/** Menu descriptors — id + human label — used to render the picker buttons. */
export const SURFACE_REGISTRY = [
  { id: 'voronoi',      label: 'Voronoi' },
  { id: 'liquid-metal', label: 'Liquid Metal' },
  { id: 'solid-black',  label: 'Solid Black' },
];

/**
 * True only for ids on the fixed allow-list. Guards persistence and any code
 * path that would otherwise trust an externally-supplied id (SEC-002).
 * @param {*} id
 * @returns {boolean}
 */
export function isValidSurfaceId(id) {
  return SURFACE_IDS.includes(id);
}

/**
 * Read the persisted surface id, validating against the allow-list.
 * Returns `fallback` when storage is empty, unavailable, or holds an
 * out-of-allow-list value.
 * @param {{getItem?: function}} storage  injected storage (e.g. localStorage)
 * @param {string} [fallback]
 * @returns {string}
 */
export function readSavedSurfaceId(storage, fallback = DEFAULT_SURFACE_ID) {
  try {
    const raw = storage && typeof storage.getItem === 'function'
      ? storage.getItem(SURFACE_STORAGE_KEY)
      : null;
    return isValidSurfaceId(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persist the surface id only when it passes the allow-list check (SEC-002).
 * @param {{setItem?: function}} storage
 * @param {string} id
 * @returns {boolean}  true when written
 */
export function writeSavedSurfaceId(storage, id) {
  if (!isValidSurfaceId(id)) return false;
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(SURFACE_STORAGE_KEY, id);
      return true;
    }
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  return false;
}
