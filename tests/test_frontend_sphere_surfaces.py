"""Unit tests for frontend/sphere-surfaces.js (registry, validation, persistence).

Imports the ES module in Node.js and serialises results back as JSON.
Skipped automatically when Node.js is not installed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

_MODULE = Path(__file__).resolve().parent.parent / "frontend" / "sphere-surfaces.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js not installed"
)


def _eval(expr: str):
    """Evaluate a JS expression against the module, return parsed JSON."""
    url = _MODULE.as_uri()
    script = (
        f"import * as m from {json.dumps(url)};"
        f"console.log(JSON.stringify({expr}));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip())


def test_surface_ids_and_default():
    assert _eval("m.SURFACE_IDS") == ["voronoi", "liquid-metal", "solid-black"]
    assert _eval("m.DEFAULT_SURFACE_ID") == "voronoi"


def test_registry_has_both_with_labels():
    reg = _eval("m.SURFACE_REGISTRY")
    ids = {entry["id"] for entry in reg}
    assert {"voronoi", "liquid-metal", "solid-black"} <= ids
    for entry in reg:
        assert entry["label"], f"empty label for {entry['id']}"


def test_is_valid_surface_id():
    assert _eval("m.isValidSurfaceId('voronoi')") is True
    assert _eval("m.isValidSurfaceId('liquid-metal')") is True
    assert _eval("m.isValidSurfaceId('solid-black')") is True
    assert _eval("m.isValidSurfaceId('not-a-surface')") is False
    assert _eval("m.isValidSurfaceId(null)") is False


def _stub_storage(value: str | None) -> str:
    """A JS snippet building a stub storage holding `value`."""
    val = "null" if value is None else json.dumps(value)
    return (
        "(()=>{let v=" + val + ";return{getItem:()=>v,"
        "setItem:(k,nv)=>{v=nv;},_get:()=>v};})()"
    )


def test_read_saved_surface_id_fallbacks():
    # Empty storage → default.
    assert _eval(f"m.readSavedSurfaceId({_stub_storage(None)})") == "voronoi"
    # Valid stored id → returned as-is.
    assert _eval(f"m.readSavedSurfaceId({_stub_storage('liquid-metal')})") == "liquid-metal"
    # Out-of-allow-list value → default, never the bad value.
    bad = _eval(f"m.readSavedSurfaceId({_stub_storage('evil; rm -rf')})")
    assert bad == "voronoi"


def test_write_saved_surface_id_refuses_invalid():
    # Valid id is written and returns true.
    assert _eval(
        "(()=>{const s=" + _stub_storage(None) + ";"
        "const ok=m.writeSavedSurfaceId(s,'liquid-metal');"
        "return [ok, s._get()];})()"
    ) == [True, "liquid-metal"]
    # Invalid id is refused (returns false, storage untouched).
    assert _eval(
        "(()=>{const s=" + _stub_storage('voronoi') + ";"
        "const ok=m.writeSavedSurfaceId(s,'bogus');"
        "return [ok, s._get()];})()"
    ) == [False, "voronoi"]
