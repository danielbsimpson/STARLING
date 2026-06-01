// ── sphere-solid.js ───────────────────────────────────────────────────────────
// "Solid black" surface effect: the sphere's original look — a dark, reflective
// MeshPhongMaterial with no procedural skin. The seven orbiting PointLights
// provide all the shading and specular highlights, exactly as before the
// pluggable-surface framework existed. Conforms to the surface-effect interface
// so it can be selected from the menu like any other effect.

/** Grouped material constants — mirror the original sphereMat (GUD-001). */
export const SOLID_CONFIG = {
  specular:          0xaaaaaa,  // bright specular for sharp orb highlights
  shininess:         52,        // tight highlight
  emissive:          0x0a0a0a,  // faint self-emission so the dark face isn't pure black
  emissiveIntensity: 1.0,
};

/**
 * Build the solid-black surface effect conforming to the surface-effect
 * interface. There are no time-varying uniforms, so update() is a no-op and the
 * effect is inherently static / reduced-motion safe.
 * @param {object} THREE  the global THREE namespace
 * @param {{sphereGeo: object, baseColor: number}} ctx
 * @returns {{id: string, material: object, update: function, dispose: function}}
 */
export function buildSolidBlackEffect(THREE, ctx) {
  const cfg = SOLID_CONFIG;
  const material = new THREE.MeshPhongMaterial({
    color:             ctx.baseColor ?? 0x060606,
    specular:          cfg.specular,
    shininess:         cfg.shininess,
    emissive:          cfg.emissive,
    emissiveIntensity: cfg.emissiveIntensity,
  });
  return {
    id: 'solid-black',
    material,
    update() { /* static surface — nothing to animate */ },
    dispose() { material.dispose(); },
  };
}
