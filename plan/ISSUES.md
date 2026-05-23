# Youtube cannot open videos
The videos that open in the browser window cannot display or show anything. This is the same for google.com, where it says cannot display and asks you to click on a link that opens a new tab. I would like to have the functionality inside the Starling system to view videos.

# Browser displays off-screen when opening youtube video
The browser window displays to the right of the YouTube panel when a video is clicked, this causes it to appear off screen for most monitors. It should simply appear on screen where the browser normally displays.

# News summaries are too aggressive
The news summary function sometimes combines stories instead of simply grouping the same headlines into a single headline. Improve the pipeline with intelligent LLM usage. Multiple LLM calls to identify if a headline is the same as another (same story, same topic).

**STATUS: SYNTHESIS DISABLED (May 2026).** Observed 151 articles collapsing into only 3 stories — the LLM was over-aggressively merging unrelated headlines. Synthesis is hard-coded off (`_SYNTHESIS_ON = False` in `backend/news.py`; polling removed from `frontend/news-panel.js`). The raw headline feed now always renders. Revisit when a more accurate grouping strategy is designed.