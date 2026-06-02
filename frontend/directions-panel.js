// frontend/directions-panel.js
// Drive-time / commute panel: trigger detection, route fetch, render, and LLM context export.

import { BACKEND_BASE } from './config.js';
import {
  initDirectionsMap,
  renderDirectionsMap,
  animateRouteFromOrigin,
  destroyDirectionsMap,
} from './directions-map.js';

const DIRECTIONS_MIN_DEST_CHARS = 2;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const _starlingEl = document.getElementById('starling');
const dirPanel = document.getElementById('directions-panel');
const dirCloseBtn = document.getElementById('directions-close-btn');
const dirTitle = document.getElementById('directions-title');
const dirFetched = document.getElementById('directions-fetched');
const dirRoute = document.getElementById('directions-route');
const dirDuration = document.getElementById('directions-duration');
const dirDistance = document.getElementById('directions-distance');
const dirMode = document.getElementById('directions-mode');
const dirTraffic = document.getElementById('directions-traffic');

// ── Service refs (injected by initDirectionsPanel) ───────────────────────────
let _enqueueSpeak = null;
let _sendToOllama = null;
let _interruptSpeech = null;

// ── State ─────────────────────────────────────────────────────────────────────
let _currentDirectionsContext = null;
let _lastQuery = null; // { destination, profile }

export function initDirectionsPanel({ enqueueSpeak, sendToOllama, interruptSpeech } = {}) {
  _enqueueSpeak = enqueueSpeak || null;
  _sendToOllama = sendToOllama || null;
  _interruptSpeech = interruptSpeech || null;
  initDirectionsMap();
}

dirCloseBtn?.addEventListener('click', closeDirectionsPanel);

function _profileFromTranscript(t) {
  if (/\b(?:walk|walking|foot|on\s+foot)\b/i.test(t)) return 'foot-walking';
  if (/\b(?:bike|biking|bicycle|cycle|cycling)\b/i.test(t)) return 'cycling-regular';
  return 'driving-car';
}

function _cleanDestination(raw) {
  if (!raw) return '';
  return raw
    .replace(/\b(?:right\s+now|now|please)\b/gi, '')
    .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns { destination, profile } for drive-time intents, otherwise null.
 */
export function detectDirectionsTrigger(transcript) {
  const t = (transcript || '').trim();
  if (!t) return null;

  let destination = null;

  const patterns = [
    /\bhow\s+long\s+to\s+(?:drive|get|go)\s+to\s+(.+)$/i,
    /\b(?:drive|driving|commute|travel|walking|walk|bike|cycling)\s+time\s+to\s+(.+)$/i,
    /\bhow\s+far\s+(?:is|to)\s+(.+)$/i,
    /\bdirections\s+to\s+(.+)$/i,
    /\bwhat(?:'s|\s+is)\s+my\s+commute\s+to\s+(.+)$/i,
  ];

  for (const re of patterns) {
    const match = t.match(re);
    if (match && match[1]) {
      destination = _cleanDestination(match[1]);
      break;
    }
  }

  if (!destination || destination.length < DIRECTIONS_MIN_DEST_CHARS) return null;

  return {
    destination,
    profile: _profileFromTranscript(t),
  };
}

function _profileLabel(profile) {
  switch (profile) {
    case 'foot-walking':
      return 'WALKING';
    case 'cycling-regular':
      return 'CYCLING';
    default:
      return 'DRIVING';
  }
}

function _renderPanel(data) {
  if (!data) return;

  const origin = data.origin?.label || 'Origin';
  const destination = data.destination?.label || 'Destination';
  dirTitle.textContent = `DRIVE TIME - ${destination.toUpperCase()}`;
  dirRoute.textContent = `${origin} -> ${destination}`;

  if (data.duration_minutes == null || data.distance_miles == null || data.distance_km == null) {
    dirDuration.textContent = '--';
    dirDistance.textContent = '--';
    dirTraffic.textContent = 'NO ROUTE AVAILABLE';
  } else {
    dirDuration.textContent = `${data.duration_minutes} MIN`;
    dirDistance.textContent = `${Number(data.distance_miles).toFixed(1)} MI (${Number(data.distance_km).toFixed(1)} KM)`;
    const hasSlowZones = Array.isArray(data.segments) && data.segments.some(s => s && s.slow_zone);
    if (hasSlowZones) {
      dirTraffic.textContent = 'ESTIMATED SLOWDOWN ZONES HIGHLIGHTED (TYPICAL CONDITIONS, NOT LIVE TRAFFIC)';
    } else {
      dirTraffic.textContent = data.traffic_adjusted
        ? 'TYPICAL RUSH-HOUR TRAFFIC ADJUSTMENT APPLIED'
        : 'TYPICAL TRAFFIC BASELINE (NO LIVE TRAFFIC FEED)';
    }
  }

  dirMode.textContent = _profileLabel(data.profile || 'driving-car');

  const fetchedDate = new Date(data.fetched_at);
  dirFetched.textContent = `UPDATED ${fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Fetch directions and open the panel.
 * Returns llm_context string or null when routing failed.
 */
export async function openDirectionsPanel({ destination, profile = 'driving-car' }) {
  const cleanDestination = _cleanDestination(destination);
  if (!cleanDestination || cleanDestination.length < DIRECTIONS_MIN_DEST_CHARS) {
    return null;
  }

  const params = new URLSearchParams();
  params.set('destination', cleanDestination);
  params.set('profile', profile);

  let data;
  try {
    const res = await fetch(`${BACKEND_BASE}/directions?${params.toString()}`);
    if (!res.ok) {
      if (res.status === 404 && typeof _enqueueSpeak === 'function') {
        _enqueueSpeak(`I couldn't find a route to ${cleanDestination}.`);
      }
      return null;
    }
    data = await res.json();
  } catch (err) {
    console.error('[directions-panel] fetch failed:', err);
    return null;
  }

  _renderPanel(data);
  _currentDirectionsContext = data.llm_context || null;
  _lastQuery = { destination: cleanDestination, profile };

  dirPanel?.classList.remove('hidden');
  _starlingEl?.classList.add('directions-mode');
  dirPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Render map first, then start route draw animation from origin -> destination.
  const hasMap = renderDirectionsMap(data);
  if (hasMap) {
    animateRouteFromOrigin({ durationMs: Number(data.animation_ms) || 7000 });
  }

  return _currentDirectionsContext;
}

export function closeDirectionsPanel() {
  _currentDirectionsContext = null;
  destroyDirectionsMap();
  _starlingEl?.classList.remove('directions-mode');
  dirPanel?.classList.add('hidden');
}

export function isDirectionsPanelOpen() {
  return dirPanel ? !dirPanel.classList.contains('hidden') : false;
}

export function getDirectionsContext() {
  return _currentDirectionsContext;
}
