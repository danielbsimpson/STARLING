// ── idle-expressiveness.js ──────────────────────────────────────────────────
// Deterministic idle-event scheduling and envelope math for the living sphere.
// These helpers are GPU-free and import nothing so they are unit-testable in
// Node, mirroring animation-easings.js.

export const IDLE_FX_CONFIG = {
  microMinDelayMs: 4000,      // minimum delay before the next idle micro-event
  microMaxDelayMs: 12000,     // maximum delay before the next idle micro-event
  pulseDurationMs: 900,       // whole-surface pulse event length
  orbBrightenDurationMs: 1100,// single-orb brighten event length
  rippleDurationMs: 1300,     // localized idle ripple event length
  blinkMinDelayMs: 6000,      // minimum delay before the next blink
  blinkMaxDelayMs: 16000,     // maximum delay before the next blink
  blinkDurationMs: 320,       // blink dim-and-recover duration
  pulseAmp: 0.05,             // additive pulse displacement amplitude
  orbBrightenAmp: 1.8,        // additive point-light brighten amplitude
  orbOpacityAmp: 0.12,        // additive visible-orb opacity bump
  rippleAmp: 0.06,            // additive localized ripple amplitude
  rippleFalloffPow: 10,       // angular falloff sharpness for localized ripple
  blinkDimFactor: 0.45,       // minimum retained light intensity during blink
  blinkGlowFactor: 0.55,      // retained glow strength during blink
  blinkRimOpacityFactor: 0.5, // retained rim opacity during blink
  kindWeights: {
    pulse: 0.4,
    orbBrighten: 0.35,
    ripple: 0.25,
  },
};

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function durationForKind(cfg, kind) {
  if (kind === 'pulse') return cfg.pulseDurationMs;
  if (kind === 'orbBrighten') return cfg.orbBrightenDurationMs;
  if (kind === 'ripple') return cfg.rippleDurationMs;
  return 0;
}

function safeDeltaMs(deltaMs) {
  return Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
}

export function drawInterval(rng = Math.random, minMs = 0, maxMs = 0) {
  return minMs + rng() * (maxMs - minMs);
}

export function pickWeightedKind(rng = Math.random, weights = {}) {
  const entries = Object.entries(weights).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  if (!entries.length) return null;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let threshold = rng() * total;
  for (let i = 0; i < entries.length; i++) {
    const [kind, weight] = entries[i];
    threshold -= weight;
    if (threshold <= 0) return kind;
  }
  return entries[entries.length - 1][0];
}

export function eventEnvelope(progress) {
  const p = clamp01(progress);
  if (p === 0 || p === 1) return 0;
  return Math.sin(p * Math.PI);
}

export function blinkEnvelope(progress) {
  const p = clamp01(progress);
  if (p === 0 || p === 1) return 0;
  if (p < 0.22) {
    return p / 0.22;
  }
  const recover = (p - 0.22) / 0.78;
  return Math.cos(recover * Math.PI * 0.5);
}

export function makeIdleScheduler(cfg, rng = Math.random) {
  let microDelayMs = drawInterval(rng, cfg.microMinDelayMs, cfg.microMaxDelayMs);
  let blinkDelayMs = drawInterval(rng, cfg.blinkMinDelayMs, cfg.blinkMaxDelayMs);
  let activeEvent = null;
  let activeBlink = null;
  let eventSeq = 0;
  let blinkSeq = 0;

  function reset() {
    microDelayMs = drawInterval(rng, cfg.microMinDelayMs, cfg.microMaxDelayMs);
    blinkDelayMs = drawInterval(rng, cfg.blinkMinDelayMs, cfg.blinkMaxDelayMs);
    activeEvent = null;
    activeBlink = null;
  }

  function activateEvent() {
    const kind = pickWeightedKind(rng, cfg.kindWeights);
    if (!kind) return;
    eventSeq += 1;
    activeEvent = {
      kind,
      seq: eventSeq,
      elapsedMs: 0,
      durationMs: durationForKind(cfg, kind),
    };
  }

  function activateBlink() {
    blinkSeq += 1;
    activeBlink = {
      seq: blinkSeq,
      elapsedMs: 0,
      durationMs: cfg.blinkDurationMs,
    };
  }

  function update(deltaMs, active) {
    if (!active) {
      reset();
      return { event: null, blink: null };
    }

    const dt = safeDeltaMs(deltaMs);

    if (activeEvent) {
      activeEvent.elapsedMs += dt;
      if (activeEvent.elapsedMs >= activeEvent.durationMs) {
        activeEvent = null;
        microDelayMs = drawInterval(rng, cfg.microMinDelayMs, cfg.microMaxDelayMs);
      }
    } else {
      microDelayMs -= dt;
      if (microDelayMs <= 0) activateEvent();
    }

    if (activeBlink) {
      activeBlink.elapsedMs += dt;
      if (activeBlink.elapsedMs >= activeBlink.durationMs) {
        activeBlink = null;
        blinkDelayMs = drawInterval(rng, cfg.blinkMinDelayMs, cfg.blinkMaxDelayMs);
      }
    } else {
      blinkDelayMs -= dt;
      if (blinkDelayMs <= 0) activateBlink();
    }

    return {
      event: activeEvent ? {
        active: true,
        kind: activeEvent.kind,
        progress: clamp01(activeEvent.durationMs > 0 ? activeEvent.elapsedMs / activeEvent.durationMs : 1),
        seq: activeEvent.seq,
      } : null,
      blink: activeBlink ? {
        active: true,
        progress: clamp01(activeBlink.durationMs > 0 ? activeBlink.elapsedMs / activeBlink.durationMs : 1),
        seq: activeBlink.seq,
      } : null,
    };
  }

  return { update, reset };
}