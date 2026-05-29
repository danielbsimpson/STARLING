// ── fuzzy-tool-detect.js ──────────────────────────────────────────────────────
// Keyword-scoring fuzzy intent detector for the Starling tool intercept chain.
// Called at intercept position N-1 (just before LLM fallback) when no canonical
// tool trigger has matched. Returns the best-matching tool entry or null.
//
// CO-CHANGE NOTE: When adding a new tool to _routeInput() in app.js, also add
// a matching entry here AND a matching case in _retriggerTool() in app.js.

export const FUZZY_THRESHOLD = 0.30;   // min fraction of keywords that must hit

// One entry per currently active tool. Keep in sync with _routeInput() in app.js.
// minMatches: overrides threshold for short or ambiguous keyword lists.
const FUZZY_TOOL_MAP = [
  {
    toolName: 'Dossier',
    fuzzyKeywords: ['dossier', 'briefing', 'profile', 'intel', 'file', 'record'],
    minMatches: 1,
  },
  {
    toolName: 'Timer',
    fuzzyKeywords: ['timer', 'remind', 'countdown', 'alarm', 'minutes', 'seconds', 'hours'],
    minMatches: 1,
  },
  {
    toolName: 'Time / Date',
    fuzzyKeywords: ['time', 'clock', 'date', 'day', 'today', 'hour'],
    minMatches: 2,    // 'time' or 'day' alone is too ambiguous; require 2 hits
  },
  {
    toolName: 'Weather',
    fuzzyKeywords: ['weather', 'forecast', 'temperature', 'rain', 'cloud', 'sunny', 'degrees'],
    minMatches: 1,
  },
  {
    toolName: 'News',
    fuzzyKeywords: ['news', 'headlines', 'briefing', 'stories', 'latest', 'update'],
    minMatches: 1,
  },
  {
    toolName: 'Stocks & Market',
    fuzzyKeywords: ['stocks', 'market', 'crypto', 'bitcoin', 'shares', 'equity', 'portfolio'],
    minMatches: 1,
  },
  {
    toolName: 'Browser',
    fuzzyKeywords: ['browser', 'browse', 'website', 'webpage', 'internet', 'navigate', 'search'],
    minMatches: 1,
  },
  {
    toolName: 'Ideas Vault',
    fuzzyKeywords: ['idea', 'ideas', 'vault', 'capture', 'store', 'note'],
    minMatches: 2,    // require at least 'idea(s)' + one other to avoid false positives
  },
  {
    toolName: 'Voice Journal',
    fuzzyKeywords: ['journal', 'diary', 'entry', 'dictate', 'write', 'record'],
    minMatches: 1,
  },
  {
    toolName: 'Wikipedia RAG',
    fuzzyKeywords: ['wikipedia', 'wiki', 'offline', 'local', 'article', 'encyclopedia'],
    minMatches: 2,    // 'local' and 'offline' are too common alone; require 2 hits
  },
  {
    toolName: 'Calendar',
    fuzzyKeywords: ['calendar', 'schedule', 'events', 'meetings', 'appointments', 'agenda'],
    minMatches: 1,
  },
  {
    toolName: 'Mail',
    fuzzyKeywords: ['email', 'mail', 'inbox', 'messages', 'unread', 'letters'],
    minMatches: 1,
  },
  {
    toolName: 'YouTube',
    fuzzyKeywords: ['youtube', 'video', 'feed', 'channel', 'subscribe'],
    minMatches: 2,    // 'video' and 'feed' too generic alone; require 'youtube' + something
  },
  {
    toolName: 'Reddit',
    fuzzyKeywords: ['reddit', 'social', 'post', 'feed', 'subreddit'],
    minMatches: 2,    // 'post' and 'feed' too generic alone; require 'reddit' + something
  },
  {
    toolName: 'Toolkit Menu',
    fuzzyKeywords: ['toolkit', 'tools', 'menu', 'commands', 'features', 'capabilities'],
    minMatches: 2,    // 'tools' alone is common; require 2 to indicate meta-intent
  },
];

/**
 * Score a transcript against each tool's keyword list.
 *
 * @param {string}   transcript  Raw STT output.
 * @param {string[]} skipNames   Tool names to exclude (already matched by canonical check).
 * @returns {{ toolName: string, confidence: number } | null}
 */
export function detectFuzzyToolIntent(transcript, skipNames = []) {
  if (!transcript || transcript.trim().length < 5) return null;

  const normalised = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const tokens     = normalised.split(/\s+/);

  let best = null;

  for (const entry of FUZZY_TOOL_MAP) {
    if (skipNames.includes(entry.toolName)) continue;

    const hits       = entry.fuzzyKeywords.filter(kw => tokens.includes(kw)).length;
    const confidence = hits / entry.fuzzyKeywords.length;

    if (hits >= entry.minMatches && confidence >= FUZZY_THRESHOLD) {
      if (!best || confidence > best.confidence) {
        best = { toolName: entry.toolName, confidence };
      }
    }
  }

  return best;
}
