export const BACKEND_BASE = 'http://localhost:8000';

// Boot / shutdown animation durations (ms).
// Increase these values if boot or shutdown takes longer than the animation.
export const BOOT_ANIMATION_MS     = 6000;
export const SHUTDOWN_ANIMATION_MS = 4000;

// Sleep / wake animation durations and inactivity threshold (ms).
// Increase SLEEP_AFTER_MS to delay the sleep trigger.  Adjust animation
// durations to match your preferred visual pacing.
export const SLEEP_AFTER_MS     = 600000;  // 10 minutes of inactivity
export const SLEEP_ANIMATION_MS = 4000;
export const WAKE_ANIMATION_MS  = 5000;

// Startup readiness polling.
// The backend (and therefore the UI) comes up before llama-server has finished
// loading. The UI stays in its blue "INIT" state and polls /system-status until
// the LLM reports ready (i.e. no longer "OFFLINE") before warming up the models.
export const READY_POLL_INTERVAL_MS = 1000;    // how often to re-poll
export const READY_POLL_TIMEOUT_MS  = 180000;  // give up after 3 minutes

// Directions map tile themes.
// Theme can be overridden at runtime via localStorage key:
//   starling_directions_map_theme = dark | light | satellite
export const DIRECTIONS_MAP_TILE_THEMES = {
	dark: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
	light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
	satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

export const DIRECTIONS_MAP_THEME = 'dark';
