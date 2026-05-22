---
goal: Expand news feed RSS scope with international English-language sources across 13 countries
version: 1.0
date_created: 2026-05-22
last_updated: 2026-05-22
owner: simps
status: 'Planned'
tags: [feature, news, rss, international]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

The S.T.A.R.L.I.N.G. news feed currently draws exclusively from US and UK wire services. This plan expands coverage by adding a new `"regional"` category in `backend/news.py` populated with 1–3 curated English-language RSS feeds from 13 countries (Ukraine, Russia, Spain, Nigeria, Pakistan, Philippines, Ireland, India, Hong Kong, Brazil, Bangladesh, and supplemental UK/US sources). A source-label mapping entry is added for every new feed domain, and the new category is exposed to the frontend through `_CATEGORY_LABELS`.

---

## 1. Requirements & Constraints

- **REQ-001**: All selected feeds must publish at least some headlines in English (or be English-only outlets).
- **REQ-002**: The new `"regional"` category must follow the existing `_CATEGORY_LABELS` / `_CATEGORY_DEFAULT_FEEDS` pattern exactly — no structural changes to feed-fetching logic.
- **REQ-003**: Each new feed domain must have a corresponding entry added to the `labels` dict inside `_source_name_from_url()`.
- **REQ-004**: The new category must be overridable via `NEWS_FEEDS_REGIONAL` environment variable (automatic via `_get_feeds_for_category()`).
- **CON-001**: No new Python dependencies may be introduced.
- **CON-002**: Feeds hosted on domains that are geo-blocked or require auth are excluded.
- **GUD-001**: Prefer independent / non-state-aligned outlets where multiple options exist for a country.
- **GUD-002**: Limit selection to ≤3 feeds per country to keep total feed count manageable.
- **PAT-001**: Follow the existing comma-separated string format used in all `_CATEGORY_DEFAULT_FEEDS` values.

---

## 2. Implementation Steps

### Implementation Phase 1 — Add source-label mappings

- GOAL-001: Extend `_source_name_from_url()` so every new feed domain resolves to a human-readable label rather than falling back to the netloc heuristic.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `backend/news.py`, inside the `labels` dict in `_source_name_from_url()`, add the following 26 key-value pairs in alphabetical order after the existing entries: `"unian.net": "UNIAN (Ukraine)"`, `"themoscowtimes.com": "The Moscow Times"`, `"tass.com": "TASS"`, `"thelocal.com": "The Local"`, `"euroweeklynews.com": "Euro Weekly News"`, `"efe.com": "Agencia EFE"`, `"premiumtimesng.com": "Premium Times Nigeria"`, `"guardian.ng": "Guardian Nigeria"`, `"tribune.com.pk": "Express Tribune"`, `"thenews.com.pk": "The News International"`, `"inquirer.net": "INQUIRER.net"`, `"gmanews.tv": "GMA News"`, `"thejournal.ie": "TheJournal.ie"`, `"breakingnews.ie": "BreakingNews.ie"`, `"ietopstories": "Irish Examiner"`, `"timesofindia.indiatimes.com": "Times of India"`, `"ndtvnews": "NDTV"`, `"thehindu.com": "The Hindu"`, `"hongkongfp.com": "Hong Kong Free Press"`, `"thestandard.com.hk": "The Standard HK"`, `"riotimesonline.com": "The Rio Times"`, `"brasilwire.com": "Brasil Wire"`, `"thedailystar.net": "The Daily Star BD"`, `"bdnews24.com": "bdnews24"`, `"independent.co.uk": "The Independent"`, `"dailymail.co.uk": "Daily Mail"` | | |

### Implementation Phase 2 — Register the new category label

- GOAL-002: Make `"regional"` a first-class category visible in the API and frontend alongside the existing 8 categories.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-002 | In `backend/news.py`, add `"regional": "REGIONAL / INTERNATIONAL"` to the `_CATEGORY_LABELS` dict (after `"entertainment"`). | | |

### Implementation Phase 3 — Add feeds to `_CATEGORY_DEFAULT_FEEDS`

- GOAL-003: Populate the `"regional"` key in `_CATEGORY_DEFAULT_FEEDS` with the curated feed list. All feeds have been verified as English-language or English-available outlets.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add the following `"regional"` entry to `_CATEGORY_DEFAULT_FEEDS` (after `"entertainment"`): | | |

```python
"regional": (
    # United Kingdom (supplemental — not in world/us)
    "http://www.independent.co.uk/news/uk/rss,"
    "https://www.dailymail.co.uk/home/index.rss,"
    # Ukraine (English wire)
    "https://rss.unian.net/site/news_eng.rss,"
    # Russia (English outlets)
    "https://www.themoscowtimes.com/rss/news,"
    "http://tass.com/rss/v2.xml,"
    # Spain (English-language outlets)
    "https://feeds.thelocal.com/rss/es,"
    "https://www.efe.com/efe/english/4/rss,"
    # Nigeria (English)
    "https://www.premiumtimesng.com/feed,"
    "https://guardian.ng/feed/,"
    # Pakistan (English dailies)
    "https://tribune.com.pk/feed/home,"
    "https://www.thenews.com.pk/rss/1/1,"
    # Philippines (English)
    "https://www.inquirer.net/fullfeed,"
    "https://data.gmanews.tv/gno/rss/news/feed.xml,"
    # Ireland (English)
    "https://www.thejournal.ie/feed/,"
    "https://feeds.breakingnews.ie/bntopstories,"
    # India (English)
    "https://timesofindia.indiatimes.com/rssfeedstopstories.cms,"
    "https://feeds.feedburner.com/ndtvnews-top-stories,"
    # Hong Kong (English)
    "https://www.hongkongfp.com/feed/,"
    "https://www.thestandard.com.hk/newsfeed/latest/news.xml,"
    # Brazil (English outlets)
    "https://riotimesonline.com/feed/,"
    "http://www.brasilwire.com/feed/,"
    # Bangladesh (English dailies)
    "https://www.thedailystar.net/frontpage/rss.xml,"
    "https://bdnews24.com/?widgetName=rssfeed&widgetId=1150&getXmlFeed=true"
),
```

### Implementation Phase 4 — Validation

- GOAL-004: Confirm the new category works end-to-end without runtime errors.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Run `python -c "from backend.news import _get_feeds_for_category; print(_get_feeds_for_category('regional'))"` from the repo root and verify it prints all 24 feed URLs. | | |
| TASK-005 | Send `GET /news?category=regional` to the running FastAPI server and confirm headlines are returned from at least 5 distinct source domains. | | |
| TASK-006 | Run `get_errors` on `backend/news.py` and confirm zero lint/type errors. | | |
| TASK-007 | Verify `GET /news?category=world` is unaffected — response should still contain only the original 4 world feeds. | | |

---

## 3. Alternatives

- **ALT-001**: Expand the existing `world` category feed list instead of creating a new category. Rejected because the world category already has a clear semantic meaning (global top-line headlines); mixing in country-specific outlets would dilute the synthesis results and make the UI label misleading.
- **ALT-002**: Create one category per country (e.g. `india`, `nigeria`). Rejected because it adds 13 new category keys, strains the frontend tab bar, and most users want a single aggregated "international" view. Country-level granularity can be layered on later via env var overrides.
- **ALT-003**: Use a language-detection library to filter non-English items at fetch time. Rejected as over-engineering — all selected feeds are established English-language outlets; runtime filtering would add latency and a new dependency.

---

## 4. Dependencies

- **DEP-001**: `feedparser` — already installed; used by `_parse_feed()` for all RSS fetching.
- **DEP-002**: `httpx` — already installed; used in the existing async fetch path.
- **DEP-003**: Network access to the 24 feed domains at runtime. No new firewall rules required beyond what the existing feeds need.

---

## 5. Files

- **FILE-001**: `backend/news.py` — sole file modified. All changes are confined to three data structures: `_source_name_from_url.labels`, `_CATEGORY_LABELS`, and `_CATEGORY_DEFAULT_FEEDS`.

---

## 6. Testing

- **TEST-001**: Unit — call `_get_feeds_for_category("regional")` and assert the returned list has exactly 24 URLs and each element is a non-empty string starting with `http`.
- **TEST-002**: Integration — `GET /news?category=regional` with live server; assert HTTP 200, response JSON is a list, and `len(response) >= 1`.
- **TEST-003**: Regression — `GET /news?category=world` still returns BBC, Reuters, AP News, NYT World (no contamination from new feeds).
- **TEST-004**: Label resolution — call `_source_name_from_url("https://www.premiumtimesng.com/feed")` and assert return value is `"Premium Times Nigeria"` (not the netloc fallback).
- **TEST-005**: Env-var override — set `NEWS_FEEDS_REGIONAL=https://example.com/rss` and confirm `_get_feeds_for_category("regional")` returns only that URL (existing override mechanism must work unchanged).

---

## 7. Risks & Assumptions

- **RISK-001**: Some feeds (e.g. `brasilwire.com`, `bdnews24.com`) may become stale or return non-standard RSS that `feedparser` cannot parse. Mitigation: `_parse_feed()` already silently returns `[]` on parse failure; the category degrades gracefully.
- **RISK-002**: RT (`rt.com`) is a Russian state media outlet. It is intentionally excluded; The Moscow Times is selected instead as an independent English-language alternative.
- **RISK-003**: `dailymail.co.uk` feeds a high volume of tabloid content. It is included as a UK supplement but can be removed by setting `NEWS_FEEDS_REGIONAL` env var without code change.
- **ASSUMPTION-001**: The existing `_PER_FEED` cap (default 5 items) and `_LLM_LIMIT` cap (default 10) are sufficient to prevent the larger feed pool from overwhelming the synthesis prompt. With 24 feeds × 5 items = 120 raw items, `_SYNTHESIS_MAX` (default 40) will truncate the list before synthesis — no changes to those limits are required.
- **ASSUMPTION-002**: The frontend `news-panel.js` already iterates `_CATEGORY_LABELS` dynamically to build category tabs; adding `"regional"` to the dict will automatically render a new tab without frontend code changes.

---

## 8. Related Specifications / Further Reading

- [backend/news.py](../backend/news.py) — full implementation reference
- [frontend/news-panel.js](../frontend/news-panel.js) — category tab rendering
- [awesome-rss-feeds United States OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/United%20States.opml)
- [awesome-rss-feeds United Kingdom OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/United%20Kingdom.opml)
- [awesome-rss-feeds Ukraine OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Ukraine.opml)
- [awesome-rss-feeds Russia OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Russia.opml)
- [awesome-rss-feeds Spain OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Spain.opml)
- [awesome-rss-feeds Nigeria OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Nigeria.opml)
- [awesome-rss-feeds Pakistan OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Pakistan.opml)
- [awesome-rss-feeds Philippines OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Philippines.opml)
- [awesome-rss-feeds Ireland OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Ireland.opml)
- [awesome-rss-feeds India OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/India.opml)
- [awesome-rss-feeds Hong Kong SAR China OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Hong%20Kong%20SAR%20China.opml)
- [awesome-rss-feeds Brazil OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Brazil.opml)
- [awesome-rss-feeds Bangladesh OPML](https://github.com/plenaryapp/awesome-rss-feeds/blob/master/countries/with_category/Bangladesh.opml)
