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
