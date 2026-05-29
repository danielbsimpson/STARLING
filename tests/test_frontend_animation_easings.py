"""Unit tests for frontend/animation-easings.js.

Each easing function is evaluated by importing the ES module in Node.js and
serialising the result back as JSON. Skipped automatically when Node.js is
not installed on the test host.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

_EASINGS = Path(__file__).resolve().parent.parent / "frontend" / "animation-easings.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js not installed"
)


def _eval(expr: str):
    """Evaluate a JS expression against the easings module, return parsed JSON."""
    url = _EASINGS.as_uri()
    script = (
        f"import * as e from {json.dumps(url)};"
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


def test_animation_easings_boundaries():
    assert _eval("e.easeOutCubic(0)") == 0
    assert _eval("e.easeOutCubic(1)") == 1
    assert _eval("e.easeInCubic(0)") == 0
    assert _eval("e.easeInCubic(1)") == 1
    assert _eval("e.easeInOutSine(0)") == 0
    assert _eval("e.easeInOutSine(1)") == pytest.approx(1.0)
    assert _eval("e.easeInOutQuad(0)") == 0
    assert _eval("e.easeInOutQuad(1)") == 1


def test_animation_easings_known_values():
    assert _eval("e.easeInCubic(0.5)") == pytest.approx(0.125)
    assert _eval("e.easeInOutSine(0.5)") == pytest.approx(0.5)


def test_animation_easings_monotonic():
    samples = _eval("Array.from({length:100},(_,i)=>e.easeOutCubic(i/99))")
    assert all(b >= a for a, b in zip(samples, samples[1:]))
    samples = _eval("Array.from({length:100},(_,i)=>e.easeInOutSine(i/99))")
    assert all(b >= a for a, b in zip(samples, samples[1:]))


def test_animation_easings_overshoot():
    assert _eval("e.easeOutBack(0.9)") > 1
    assert _eval("e.easeOutBack(1)") == pytest.approx(1.0)
