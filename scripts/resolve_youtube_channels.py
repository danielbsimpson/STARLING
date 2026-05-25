#!/usr/bin/env python3
"""
Resolve YouTube channel handles to channel IDs (no API key required).

Run from the project root:
    python scripts/resolve_youtube_channels.py

Reads  backend/memory/youtube_channels.json
Resolves any channel that has a 'handle' but no 'channel_id' by scraping
the YouTube channel page and extracting the embedded channelId field.
Saves resolved IDs back to the same file.

A 1.5-second delay is inserted between requests to avoid triggering
YouTube rate-limiting.
"""

import asyncio
import json
import re
import time
from pathlib import Path

import httpx

CHANNELS_FILE    = Path(__file__).parent.parent / "backend" / "memory" / "youtube_channels.json"
CHANNEL_ID_RE    = re.compile(r"^UC[A-Za-z0-9_\-]{22}$")
REQUEST_DELAY_S  = 1.5   # seconds between requests


async def _resolve_handle(client: httpx.AsyncClient, handle: str) -> str | None:
    """Scrape https://www.youtube.com/@{handle} and extract the channel ID."""
    clean = re.sub(r"^@", "", handle.strip())
    if not re.match(r"^[A-Za-z0-9._-]{1,100}$", clean):
        return None
    url = f"https://www.youtube.com/@{clean}"
    try:
        resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0 (compatible; STARLING/1.0)"})
        # Primary: channelId JSON field in page source
        m = re.search(r'"channelId":"(UC[A-Za-z0-9_\-]{22})"', resp.text)
        if m and CHANNEL_ID_RE.match(m.group(1)):
            return m.group(1)
        # Fallback: canonical link tag
        m = re.search(
            r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[A-Za-z0-9_\-]{22})"',
            resp.text,
        )
        if m and CHANNEL_ID_RE.match(m.group(1)):
            return m.group(1)
    except Exception as exc:
        print(f"    HTTP error: {exc}")
    return None


async def main() -> None:
    if not CHANNELS_FILE.exists():
        print(f"[ERROR] Channel file not found: {CHANNELS_FILE}")
        return

    raw: list = json.loads(CHANNELS_FILE.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        print("[ERROR] youtube_channels.json is not a list.")
        return

    pending = [
        item for item in raw
        if isinstance(item, dict)
        and not item.get("channel_id")
        and item.get("handle")
    ]
    already_resolved = sum(
        1 for item in raw
        if isinstance(item, dict) and item.get("channel_id")
    )
    no_handle = sum(
        1 for item in raw
        if isinstance(item, dict) and not item.get("channel_id") and not item.get("handle")
    )

    print(f"Channel file: {CHANNELS_FILE}")
    print(f"  Total entries : {len(raw)}")
    print(f"  Already resolved : {already_resolved}")
    print(f"  Pending (have handle) : {len(pending)}")
    print(f"  No handle (skip) : {no_handle}")
    print()

    if not pending:
        print("Nothing to resolve — all channels are already resolved.")
        return

    resolved_count = 0
    failed: list[str] = []

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        for i, item in enumerate(raw):
            if not isinstance(item, dict):
                continue
            if item.get("channel_id") or not item.get("handle"):
                continue

            name   = item.get("name") or item.get("handle") or "?"
            handle = item["handle"]
            idx    = pending.index(item) + 1
            print(f"[{idx}/{len(pending)}] {name!r:50s} @{handle} ... ", end="", flush=True)

            channel_id = await _resolve_handle(client, handle)
            if channel_id:
                item["channel_id"] = channel_id
                resolved_count += 1
                print(f"OK  {channel_id}")
            else:
                failed.append(name)
                print("FAILED")

            await asyncio.sleep(REQUEST_DELAY_S)

    # Save results
    CHANNELS_FILE.write_text(json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8")

    print()
    print(f"Done. Resolved: {resolved_count} / {len(pending)}")
    if failed:
        print(f"\nFailed ({len(failed)}) — add these channel IDs manually:")
        for name in failed:
            print(f"  - {name}")
        print(
            "\nTo add a channel manually, find its ID on YouTube (channel page URL or"
            " page source search for 'channelId'), then update youtube_channels.json."
        )


if __name__ == "__main__":
    asyncio.run(main())
