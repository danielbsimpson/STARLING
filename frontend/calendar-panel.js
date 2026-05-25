// frontend/calendar-panel.js
// Calendar panel: trigger detection, data fetch, render, and LLM context export.

import { BACKEND_BASE } from './config.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const calPanel       = document.getElementById('cal-panel');
const calTodayLabel  = document.getElementById('cal-today-label');
const calTz          = document.getElementById('cal-tz');
const calTodayList   = document.getElementById('cal-today-list');
const calWeekList    = document.getElementById('cal-week-list');
const calWeekToggle  = document.getElementById('cal-week-toggle');
const calWeekChevron = document.getElementById('cal-week-chevron');
const ftrCal         = document.getElementById('ftr-cal-backend');

// ── Collapsible week section ──────────────────────────────────────────────────
calWeekToggle?.addEventListener('click', () => {
  const hidden = calWeekList.classList.toggle('hidden');
  if (calWeekChevron) calWeekChevron.textContent = hidden ? '▸' : '▾';
});

// ── Trigger detection ─────────────────────────────────────────────────────────
export function detectCalendarTrigger(transcript) {
  const t = transcript.trim().toLowerCase();

  const patterns = [
    /\b(?:check|show|open|view|what(?:'s| is| are)|pull up)\b.{0,25}\b(?:calendar|schedule|agenda|events?|meetings?|appointments?)\b/,
    /\bwhat(?:'s| is)\s+(?:on\s+)?(?:my\s+)?(?:schedule|calendar|agenda|plate)\b/,
    /\bdo\s+i\s+have\s+(?:any\s+)?(?:meetings?|events?|appointments?|calls?)\b/,
    /\b(?:any|got any)\s+(?:meetings?|events?|appointments?|calls?)\s+today\b/,
    /\bwhat(?:'s| is)\s+(?:on\s+)?(?:today|this\s+week|tomorrow)\b/,
    /\bmy\s+(?:day|week|schedule|agenda|calendar)\b/,
    /\b(?:refresh|update|sync)\s+(?:my\s+)?(?:calendar|schedule)\b/,
  ];

  return patterns.some(p => p.test(t)) ? true : null;
}

// ── Panel open / close ────────────────────────────────────────────────────────

/**
 * Fetch calendar data and open the panel.
 * Pass forceRefresh=true to bust the server-side cache first.
 * Returns the llm_context string, or null on failure.
 */
export async function openCalendarPanel(forceRefresh = false) {
  if (forceRefresh) {
    try {
      await fetch(`${BACKEND_BASE}/calendar/cache`, { method: 'DELETE' });
    } catch (_) { /* ignore */ }
  }

  let data;
  try {
    const res = await fetch(`${BACKEND_BASE}/calendar`);
    if (!res.ok) throw new Error(`Calendar API ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error('[calendar-panel] fetch failed:', err);
    return null;
  }

  _renderPanel(data);
  if (ftrCal) ftrCal.textContent = data.backend?.toUpperCase() ?? 'CAL';
  calPanel?.classList.remove('hidden');
  calPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  return data.llm_context ?? null;
}

export function closeCalendarPanel() {
  calPanel?.classList.add('hidden');
}

export function isCalendarPanelOpen() {
  return calPanel ? !calPanel.classList.contains('hidden') : false;
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderPanel(data) {
  const { today, week, today_label, timezone } = data;

  if (calTodayLabel) calTodayLabel.textContent = today_label.toUpperCase();
  if (calTz)         calTz.textContent         = timezone;

  // Today's events
  if (calTodayList) {
    calTodayList.innerHTML = '';
    if (!today.length) {
      calTodayList.innerHTML = '<div class="cal-empty">No events today.</div>';
    } else {
      today.forEach(e => calTodayList.appendChild(_makeEventRow(e)));
    }
  }

  // Week events grouped by day, excluding today
  if (calWeekList) {
    calWeekList.innerHTML = '';
    const todayDates = new Set(today.map(e => e.date));
    const byDay = new Map();
    for (const e of week) {
      if (todayDates.has(e.date)) continue;
      if (!byDay.has(e.day)) byDay.set(e.day, []);
      byDay.get(e.day).push(e);
    }

    if (!byDay.size) {
      calWeekList.innerHTML = '<div class="cal-empty">Nothing else this period.</div>';
    } else {
      for (const [day, events] of byDay) {
        const dayLabel = document.createElement('div');
        dayLabel.className   = 'cal-event-day-label';
        dayLabel.textContent = day.toUpperCase();
        calWeekList.appendChild(dayLabel);
        events.forEach(e => calWeekList.appendChild(_makeEventRow(e)));
      }
    }
  }
}

function _makeEventRow(event) {
  const row = document.createElement('div');
  row.className = 'cal-event';
  row.innerHTML = `
    <div class="cal-event-time">${_esc(event.time)}</div>
    <div class="cal-event-title">${_esc(event.title)}</div>
    ${event.location ? `<div class="cal-event-location">📍 ${_esc(event.location)}</div>` : ''}
  `;
  return row;
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
