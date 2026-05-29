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

import { BACKEND_BASE } from './config.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const _starlingEl    = document.getElementById('starling');
const wxPanel        = document.getElementById('weather-panel');
const wxLocation     = document.getElementById('weather-location');
const wxLocationLabel = document.getElementById('weather-location-label');
const wxCacheAge     = document.getElementById('weather-cache-age');
const wxRefreshBtn   = document.getElementById('weather-refresh-btn');
const wxCloseBtn     = document.getElementById('weather-close-btn');
const wxFetched      = document.getElementById('weather-fetched');
const wxTemp         = document.getElementById('weather-temp');
const wxCondition    = document.getElementById('weather-condition');
const wxFeels        = document.getElementById('weather-feels');
const wxHumidity     = document.getElementById('weather-humidity');
const wxWind         = document.getElementById('weather-wind');
const wxCloud        = document.getElementById('weather-cloud');
const wxUv           = document.getElementById('weather-uv');
const wxUvLabel      = document.getElementById('weather-uv-label');
const wxAqi          = document.getElementById('weather-aqi');
const wxAqiLabel     = document.getElementById('weather-aqi-label');
const wxSunrise      = document.getElementById('weather-sunrise');
const wxSunset       = document.getElementById('weather-sunset');
const wxForecast     = document.getElementById('weather-forecast');
const ftrWxBadge     = document.getElementById('ftr-wx-location');
// ── Flip-view DOM refs ────────────────────────────────────────────────────────
const wxFlip          = document.getElementById('weather-flip');
const wxFlipBack      = document.getElementById('weather-flip-back');
const wxBackWeeklyBtn = document.getElementById('wx-back-weekly-btn');
const wxFlipDayLabel  = document.getElementById('wx-flip-day-label');
const wxDayTempCanvas  = document.getElementById('wx-day-temp');
const wxDayPrecipCanvas = document.getElementById('wx-day-precip');

// ── Last-opened location (for Refresh button) ─────────────────────────────────
let _lastLocationOverride = null;
// ── Last weather context string (for LLM follow-up injection) ──────────────
let _currentWeatherContext = null;
// ── Full weather response + active hourly Chart.js instances ─────────────────
let _weatherData = null;
let _wxCharts = { dayTemp: null, dayPrecip: null };
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
 * Call once at startup to wire panel controls (Refresh button, etc.).
 * Reserved for future shared-service injection.
 */
export function initWeatherPanel() {
  // Refresh button — force-fetch live data for the last-used location
  if (wxRefreshBtn) {
    wxRefreshBtn.addEventListener('click', async () => {
      wxRefreshBtn.disabled = true;
      wxRefreshBtn.textContent = '⏳';
      const result = await openWeatherPanel(_lastLocationOverride, /* force */ true);
      // No LLM briefing on manual refresh — panel stays open
      wxRefreshBtn.disabled = false;
      wxRefreshBtn.textContent = '🔄';
    });
  }

  if (wxCloseBtn) {
    wxCloseBtn.addEventListener('click', () => closeWeatherPanel());
  }

  // "Back to Weekly" → flip back and tear down day charts
  if (wxBackWeeklyBtn) {
    wxBackWeeklyBtn.addEventListener('click', () => _flipToWeekly());
  }

  // Keep day charts sized with the responsive panel while flipped
  window.addEventListener('resize', () => {
    if (wxFlip?.classList.contains('flipped')) {
      _wxCharts.dayTemp?.resize?.();
      _wxCharts.dayPrecip?.resize?.();
    }
  });
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
  const url = `${BACKEND_BASE}/weather${params.size ? '?' + params : ''}`;

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
  _weatherData = data;
  wxPanel.classList.remove('hidden');
  _starlingEl.classList.add('weather-mode');
  wxPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Update footer badge
  if (ftrWxBadge) ftrWxBadge.textContent = data.display_name.split(',')[0].toUpperCase();

  // Append retrieval timestamp to LLM context
  const fetchedDate = new Date(data.fetched_at);
  const timeStr = fetchedDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const sourceNote = data.source === 'cache'
    ? `[Weather data from cache, last fetched at ${timeStr} local time.]`
    : `[Weather data retrieved at ${timeStr} local time.]`;
  _currentWeatherContext = `${data.llm_context} ${sourceNote}`;
  return _currentWeatherContext;
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
  _currentWeatherContext = null;
  _destroyWxCharts();
  if (wxFlip) wxFlip.classList.remove('flipped');
  _starlingEl.classList.remove('weather-mode');
  wxPanel.classList.add('hidden');
}

/** True when the weather panel is visible on screen. */
export function isWeatherPanelOpen() {
  return wxPanel ? !wxPanel.classList.contains('hidden') : false;
}

/**
 * Returns the full weather context string (current + forecast) for LLM injection
 * during follow-up conversations, or null if the panel is closed.
 */
export function getWeatherContext() {
  return _currentWeatherContext;
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

  // UV index + air quality tiles
  if (wxUv)      wxUv.textContent      = c.uv_index != null ? `${c.uv_index}` : '—';
  if (wxUvLabel) wxUvLabel.textContent = c.uv_label || '—';
  if (wxAqi)      wxAqi.textContent      = c.us_aqi != null ? `${c.us_aqi}` : '—';
  if (wxAqiLabel) wxAqiLabel.textContent = c.aqi_label || '—';

  // Sunrise / sunset from today's forecast
  if (forecast.length) {
    wxSunrise.textContent = forecast[0].sunrise || '—';
    wxSunset.textContent  = forecast[0].sunset  || '—';
  }

  // 10-day vertical forecast — one clickable row per day
  wxForecast.innerHTML = '';
  forecast.forEach((day, i) => {
    const icon = WMO_ICON[day.weather_code] ?? '—';
    const card = document.createElement('div');
    card.className = 'forecast-day';
    card.dataset.dayIndex = i;
    card.innerHTML = `
      <div class="forecast-day-name">${day.day.slice(0, 3).toUpperCase()}</div>
      <div class="forecast-day-icon">${icon}</div>
      <div class="forecast-day-cond">${day.condition}</div>
      <div class="forecast-day-temps">
        <span class="forecast-day-high">${day.high}${c.unit_temp}</span>
        <span class="forecast-day-low">${day.low}${c.unit_temp}</span>
      </div>
    `;
    card.addEventListener('click', () => _flipToDay(i));
    wxForecast.appendChild(card);
  });
}

// ── Hourly flip view ──────────────────────────────────────────────────────────

/** Destroy any active hourly Chart.js instances and reset references. */
function _destroyWxCharts() {
  for (const key of Object.keys(_wxCharts)) {
    _wxCharts[key]?.destroy?.();
    _wxCharts[key] = null;
  }
}

/**
 * Chart.js options mirroring the stocks panel's `_tileChartOptions`: dark theme,
 * minimal axes, no animation. When `max` is provided the y-axis is pinned to
 * 0–`max` (precip %); otherwise it auto-scales so temperature variation is
 * visible instead of being flattened against a forced 0 baseline.
 */
function _wxChartOptions(yLabel, { max } = {}) {
  const yScale = max != null
    ? { min: 0, max, ticks: { color: '#666', font: { size: 9 }, stepSize: 25 },
        grid: { color: 'rgba(255,255,255,0.04)' } }
    : { ticks: { color: '#666', font: { size: 9 }, maxTicksLimit: 5 },
        grid: { color: 'rgba(255,255,255,0.04)' } };
  return {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           false,
    interaction:         { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#111', titleColor: '#aaa', bodyColor: '#eee',
        borderColor: '#333', borderWidth: 1,
        callbacks: { label: item => ` ${item.formattedValue} ${yLabel}` },
      },
    },
    scales: {
      x: {
        ticks: { color: '#666', font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        grid:  { color: 'rgba(255,255,255,0.04)' },
      },
      y: yScale,
    },
  };
}

/** Build the temperature + precipitation-probability charts for one hourly entry. */
function _renderHourlyCharts(hourlyEntry, unitTemp) {
  _destroyWxCharts();
  if (typeof Chart === 'undefined' || !hourlyEntry) return;

  const labels = hourlyEntry.time;

  if (wxDayTempCanvas) {
    _wxCharts.dayTemp = new Chart(wxDayTempCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data:            hourlyEntry.temperature,
          borderColor:     '#f0a500',
          borderWidth:     1.5,
          backgroundColor: 'rgba(240, 165, 0, 0.12)',
          fill:            true,
          pointRadius:     0,
          tension:         0.3,
        }],
      },
      options: _wxChartOptions(unitTemp || ''),
    });
  }

  if (wxDayPrecipCanvas) {
    _wxCharts.dayPrecip = new Chart(wxDayPrecipCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data:            hourlyEntry.precip_probability,
          borderColor:     '#4a9eff',
          borderWidth:     1.5,
          backgroundColor: 'rgba(74, 158, 255, 0.12)',
          fill:            true,
          pointRadius:     0,
          tension:         0.3,
        }],
      },
      options: _wxChartOptions('%', { max: 100 }),
    });
  }
}

/** Flip the forecast region to show the hourly charts for forecast day `i`. */
async function _flipToDay(i) {
  clearTimeout(_autoDismissTimer);  // CON-001: don't auto-close mid-interaction
  _autoDismissTimer = null;

  // A response cached before the hourly feature shipped won't have `hourly`.
  // Force a fresh fetch once so the charts can render instead of silently failing.
  if (!_weatherData?.hourly?.length) {
    await openWeatherPanel(_lastLocationOverride, /* force */ true);
  }

  const entry = _weatherData?.hourly?.[i];
  if (!entry) return;
  if (wxFlipDayLabel) wxFlipDayLabel.textContent = _weatherData.forecast?.[i]?.day || '';
  _renderHourlyCharts(entry, _weatherData.current?.unit_temp);
  wxFlip?.classList.add('flipped');
}

/** Flip back to the weekly forecast and tear down the day charts. */
function _flipToWeekly() {
  wxFlip?.classList.remove('flipped');
  _destroyWxCharts();
}
