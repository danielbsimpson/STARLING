// frontend/weather-panel.js
// Weather panel: trigger detection, data fetch, render, and LLM context export.
//
// Enhancement 1 — Local JSON Cache:
//   The backend now persists responses to disk. The panel shows "Last updated X min ago"
//   when serving cached data, and a 🔄 Refresh button forces a live fetch.
//
// Enhancement 2 — Location-Aware Queries:
//   detectWeatherTrigger() extracts an optional location from the voice transcript.
//   The resolved display_name is shown in the panel header.  When the user asks for
//   a location other than home, a secondary label "SHOWING RESULTS FOR <X>" appears.
//   An unknown location (HTTP 422) is surfaced as a spoken error without opening the panel.

const BACKEND_BASE_WX = 'http://localhost:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const _starlingEl    = document.getElementById('starling');
const wxPanel        = document.getElementById('weather-panel');
const wxLocation     = document.getElementById('weather-location');
const wxLocationLabel = document.getElementById('weather-location-label');
const wxCacheAge     = document.getElementById('weather-cache-age');
const wxRefreshBtn   = document.getElementById('weather-refresh-btn');
const wxFetched      = document.getElementById('weather-fetched');
const wxTemp         = document.getElementById('weather-temp');
const wxCondition    = document.getElementById('weather-condition');
const wxFeels        = document.getElementById('weather-feels');
const wxHumidity     = document.getElementById('weather-humidity');
const wxWind         = document.getElementById('weather-wind');
const wxCloud        = document.getElementById('weather-cloud');
const wxSunrise      = document.getElementById('weather-sunrise');
const wxSunset       = document.getElementById('weather-sunset');
const wxForecast     = document.getElementById('weather-forecast');
const ftrWxBadge     = document.getElementById('ftr-wx-location');

// ── Stored services (injected via initWeatherPanel) ───────────────────────────
let _enqueueSpeak = null;

// ── Last-opened location (for Refresh button) ─────────────────────────────────
let _lastLocationOverride = null;

// ── WMO code → emoji icon mapping ────────────────────────────────────────────
const WMO_ICON = {
  0: '☀️',  1: '🌤', 2: '⛅', 3: '☁️',
  45: '🌫', 48: '🌫',
  51: '🌦', 53: '🌦', 55: '🌧',
  61: '🌧', 63: '🌧', 65: '🌧',
  71: '🌨', 73: '🌨', 75: '❄️', 77: '❄️',
  80: '🌦', 81: '🌦', 82: '⛈',
  85: '🌨', 86: '❄️',
  95: '⛈', 96: '⛈', 99: '⛈',
};

// ── Auto-dismiss ─────────────────────────────────────────────────────────────
let _autoDismissTimer = null;

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Call once at startup to inject shared services from app.js.
 * @param {{ enqueueSpeak: Function }} services
 */
export function initWeatherPanel({ enqueueSpeak }) {
  _enqueueSpeak = enqueueSpeak;

  // Refresh button — force-fetch live data for the last-used location
  if (wxRefreshBtn) {
    wxRefreshBtn.addEventListener('click', async () => {
      wxRefreshBtn.disabled = true;
      wxRefreshBtn.textContent = '⏳';
      const result = await openWeatherPanel(_lastLocationOverride, /* force */ true);
      // No LLM briefing on manual refresh — start the countdown immediately after render
      if (result && typeof result === 'string') startWeatherAutoDismiss();
      wxRefreshBtn.disabled = false;
      wxRefreshBtn.textContent = '🔄';
    });
  }
}

// ── Trigger detection ─────────────────────────────────────────────────────────

/**
 * Check a raw Whisper transcript for a weather trigger phrase.
 * Returns { triggered: true, location: string|null } if matched, or null if not.
 *
 * Examples:
 *   "check the weather"               → { triggered: true, location: null }
 *   "what's the weather in Boston"    → { triggered: true, location: "Boston" }
 *   "how's the weather in London"     → { triggered: true, location: "London" }
 *   "show me the weather for Paris"   → { triggered: true, location: "Paris" }
 *   "forecast for Tokyo"              → { triggered: true, location: "Tokyo" }
 *   "let me see the weather in Denver"→ { triggered: true, location: "Denver" }
 */
export function detectWeatherTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  const barePatterns = [
    /\b(?:check|show|what(?:'s| is)|get|tell me)\b.{0,20}\bweather\b/,
    /\bweather\s+(?:forecast|update|report|conditions?|today|now)\b/,
    /\bforecast\b/,
    /\bhow(?:'s| is)\s+(?:it\s+)?(?:looking\s+)?outside\b/,
    /\bwhat(?:'s| is)\s+(?:it\s+)?like\s+outside\b/,
    /\blet\s+me\s+(?:see|check)\b.{0,20}\bweather\b/,
  ];

  const matched = barePatterns.some(p => p.test(t));
  if (!matched) return null;

  // Optional location: capture everything after "in / for / at" that follows
  // "weather" or "forecast", up to end-of-string (strip trailing punctuation).
  // Uses case-insensitive flag so Whisper lowercase output is handled correctly.
  const locMatch = transcript.match(
    /\b(?:weather|forecast)\b.{0,20}\b(?:in|for|at)\s+([A-Za-z][a-zA-Z\s,'.-]+?)[\s?.!]*$/i
  );
  const location = locMatch ? locMatch[1].trim().replace(/[?.!,]+$/, '') : null;

  return { triggered: true, location };
}

// ── Panel open / close ────────────────────────────────────────────────────────

/**
 * Fetch weather data and open the panel.
 *
 * @param {string|null} locationOverride  Named location to query (null = home default).
 * @param {boolean}     force             Bypass the backend file cache (default false).
 * @returns {string|null|{_wxErr:string}}
 *   - string     → llm_context for injection into Starling's prompt
 *   - null       → fetch failed (generic error)
 *   - {_wxErr}   → unknown location (422); caller should speak the message
 */
export async function openWeatherPanel(locationOverride = null, force = false) {
  _lastLocationOverride = locationOverride;

  const params = new URLSearchParams();
  if (locationOverride) params.set('location', locationOverride);
  if (force)            params.set('force', 'true');
  const url = `${BACKEND_BASE_WX}/weather${params.size ? '?' + params : ''}`;

  let data;
  try {
    const res = await fetch(url);
    if (res.status === 422) {
      const body = await res.json().catch(() => ({}));
      const place = locationOverride || 'that location';
      return {
        _wxErr: `I couldn't find a weather location called ${place}. Try being more specific.`,
      };
    }
    if (!res.ok) throw new Error(`Weather API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[weather-panel] fetch failed:', err);
    return null;
  }

  _renderPanel(data);
  wxPanel.classList.remove('hidden');
  _starlingEl.classList.add('weather-mode');
  wxPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Update footer badge
  if (ftrWxBadge) ftrWxBadge.textContent = data.display_name.split(',')[0].toUpperCase();

  // Auto-dismiss is started externally (by app.js, after TTS finishes) via
  // startWeatherAutoDismiss() — do NOT start it here.

  // Append retrieval timestamp to LLM context
  const fetchedDate = new Date(data.fetched_at);
  const timeStr = fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const sourceNote = data.source === 'cache'
    ? `[Weather data from cache, last fetched at ${timeStr} local time.]`
    : `[Weather data retrieved at ${timeStr} local time.]`;
  return `${data.llm_context} ${sourceNote}`;
}

/**
 * Start (or restart) the 30-second auto-dismiss countdown.
 * Call this once Starling has finished speaking the weather briefing so the panel
 * stays visible the whole time audio is playing.
 */
export function startWeatherAutoDismiss(delay = 15_000) {
  clearTimeout(_autoDismissTimer);
  _autoDismissTimer = setTimeout(closeWeatherPanel, delay);
}

export function closeWeatherPanel() {
  clearTimeout(_autoDismissTimer);
  _autoDismissTimer = null;
  _starlingEl.classList.remove('weather-mode');
  wxPanel.classList.add('hidden');
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { current: c, forecast, display_name, is_default_location, fetched_at, source, cache_age_seconds } = data;

  // Header — location title
  wxLocation.textContent = display_name.toUpperCase();

  // Secondary label: shown only when a location override is active
  if (wxLocationLabel) {
    if (!is_default_location) {
      wxLocationLabel.textContent = `SHOWING RESULTS FOR ${display_name.toUpperCase()}`;
      wxLocationLabel.classList.remove('hidden');
    } else {
      wxLocationLabel.classList.add('hidden');
      wxLocationLabel.textContent = '';
    }
  }

  // Cache-age label
  if (wxCacheAge) {
    if (source === 'cache' && cache_age_seconds > 0) {
      const mins = Math.round(cache_age_seconds / 60);
      wxCacheAge.textContent = mins <= 1 ? 'LAST UPDATED JUST NOW' : `LAST UPDATED ${mins} MIN AGO`;
      wxCacheAge.classList.remove('hidden');
    } else {
      wxCacheAge.textContent = '';
      wxCacheAge.classList.add('hidden');
    }
  }

  // Fetch timestamp
  const fetchedDate = new Date(fetched_at);
  wxFetched.textContent = `UPDATED ${fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

  // Current conditions
  wxTemp.textContent      = `${c.temp}${c.unit_temp}`;
  wxCondition.textContent = c.condition.toUpperCase();
  wxFeels.textContent     = `${c.feels_like}${c.unit_temp}`;
  wxHumidity.textContent  = `${c.humidity}%`;
  wxWind.textContent      = `${c.wind_speed} ${c.unit_wind} ${c.wind_dir}`;
  wxCloud.textContent     = `${c.cloud_cover}%`;

  // Sunrise / sunset from today's forecast
  if (forecast.length) {
    wxSunrise.textContent = forecast[0].sunrise || '—';
    wxSunset.textContent  = forecast[0].sunset  || '—';
  }

  // 7-day forecast strip
  wxForecast.innerHTML = '';
  forecast.forEach(day => {
    const icon = WMO_ICON[day.weather_code] ?? '—';
    const card = document.createElement('div');
    card.className = 'forecast-day';
    card.innerHTML = `
      <div class="forecast-day-name">${day.day.slice(0, 3).toUpperCase()}</div>
      <div class="forecast-day-icon">${icon}</div>
      <div class="forecast-day-high">${day.high}${c.unit_temp}</div>
      <div class="forecast-day-low">${day.low}${c.unit_temp}</div>
      <div class="forecast-day-cond">${day.condition}</div>
    `;
    wxForecast.appendChild(card);
  });
}
