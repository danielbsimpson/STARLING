// ── sphere-surface-manager.js ─────────────────────────────────────────────────
// Holds the active sphere surface effect and swaps it at runtime. Owns ONLY the
// sphere mesh's material — the rim mesh, orbs, and shared geometry are never
// passed in, so disposing a previous effect can never break them (RISK-002).
//
// The manager is the single integration point for animate(): the render loop
// calls updateActive() exactly once per frame, with no per-effect branching
// (PAT-002). Selection is persisted via the validated helpers in
// sphere-surfaces.js (SEC-002).

import { isValidSurfaceId, writeSavedSurfaceId } from './sphere-surfaces.js';

/**
 * Create a surface manager.
 * @param {object}   opts
 * @param {object}   opts.THREE           the global THREE namespace
 * @param {object}   opts.sphereMesh      the mesh whose material is swapped
 * @param {object}   opts.builders        map of id -> build(THREE, ctx) builder
 * @param {object}   [opts.storage]       injectable storage (default localStorage)
 * @param {function} opts.getFrameContext returns the per-frame context object
 * @param {number}   [opts.baseColor]     hex base colour passed to builders
 * @returns {{applyEffect:function, updateActive:function, getActiveId:function, dispose:function}}
 */
export function createSurfaceManager({
  THREE,
  sphereMesh,
  builders,
  storage = (typeof window !== 'undefined' ? window.localStorage : null),
  getFrameContext,
  baseColor = 0x060606,
}) {
  let activeEffect = null;
  let activeId     = null;

  /**
   * Build + activate the effect for `id`. Validates the id, disposes the
   * previous effect's GPU resources, swaps the mesh material, and persists the
   * choice. No-ops safely when the id is already active or unknown.
   * @param {string} id
   * @returns {boolean} true when a new effect was applied
   */
  function applyEffect(id) {
    if (!isValidSurfaceId(id)) return false;
    if (id === activeId && activeEffect) return false;

    const builder = builders ? builders[id] : null;
    if (typeof builder !== 'function') return false;

    const ctx = { sphereGeo: sphereMesh.geometry, baseColor };
    const effect = builder(THREE, ctx);
    if (!effect || !effect.material) return false;

    // Only dispose the previous effect once the new one built successfully,
    // so a builder error leaves the current surface intact (CON-004).
    if (activeEffect && typeof activeEffect.dispose === 'function') {
      activeEffect.dispose();
    }
    sphereMesh.material = effect.material;
    activeEffect = effect;
    activeId     = id;
    writeSavedSurfaceId(storage, id);
    return true;
  }

  /** Drive the active effect's per-frame uniform refresh. */
  function updateActive() {
    if (activeEffect && typeof activeEffect.update === 'function') {
      activeEffect.update(getFrameContext());
    }
  }

  /** @returns {?string} the active effect id (null before first apply). */
  function getActiveId() {
    return activeId;
  }

  /** Release the active effect's GPU resources. */
  function dispose() {
    if (activeEffect && typeof activeEffect.dispose === 'function') {
      activeEffect.dispose();
    }
    activeEffect = null;
    activeId     = null;
  }

  return { applyEffect, updateActive, getActiveId, dispose };
}
