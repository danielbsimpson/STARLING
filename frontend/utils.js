// frontend/utils.js
// Shared frontend helpers. Keep this module tiny and dependency-free.

/**
 * Escape a value for safe insertion into HTML text or attribute context.
 * Handles &, <, >, and " (the superset previously implemented across panels).
 * Null/undefined coerce to empty string.
 */
export function escapeHtml(value) {
  return (value ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fetch a URL and parse its body as JSON. Throws on non-2xx with
 * a message of the form "HTTP <status>".
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Produce a 1–2 sentence spoken summary of a /system/status payload.
 * Used by the voice trigger handler so Starling can answer "system status".
 */
export function formatStatusForVoice(status) {
  if (!status || typeof status !== 'object') return 'System status unavailable.';
  const boot = status.boot    || {};
  const tools = status.tools  || {};
  const rt    = status.runtime || {};
  const llm   = boot.llm  || {};
  const stt   = boot.stt  || {};
  const tts   = boot.tts  || {};
  const gpu   = rt.gpu_vram || null;

  const llmPart = `${llm.model || 'unknown LLM'} on ${gpu ? 'the GPU' : (llm.backend || 'CPU')}`;
  const bootPart = boot.boot_duration_s != null
    ? `boot took ${boot.boot_duration_s} seconds`
    : 'boot duration unknown';

  const toolIds = Object.keys(tools);
  const enabled = toolIds.filter(id => tools[id] && tools[id].enabled);
  const degraded = toolIds.filter(id => tools[id] && !tools[id].enabled);
  let toolsPart;
  if (!toolIds.length) {
    toolsPart = 'no tools registered';
  } else if (!degraded.length) {
    toolsPart = `all ${enabled.length} tools available`;
  } else {
    toolsPart = `${enabled.length} of ${toolIds.length} tools available; ` +
      `${degraded.join(', ')} need attention`;
  }

  let gpuPart = '';
  if (gpu && (gpu.used_mib + gpu.free_mib) > 0) {
    const total = gpu.used_mib + gpu.free_mib;
    const pct = Math.round((gpu.used_mib / total) * 100);
    gpuPart = ` GPU at ${pct} percent VRAM.`;
  }

  return `Running ${llmPart}. STT ${stt.model || 'unknown'}, TTS ${tts.model || 'unknown'}. ` +
    `${bootPart}, ${toolsPart}.${gpuPart}`;
}
