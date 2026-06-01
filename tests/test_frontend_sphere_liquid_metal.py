"""Unit tests for frontend/sphere-liquid-metal.js pure functions + GLSL safety.

Skipped automatically when Node.js is not installed.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

_MODULE = Path(__file__).resolve().parent.parent / "frontend" / "sphere-liquid-metal.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js not installed"
)


def _eval(expr: str):
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


def test_pole_distance():
    assert _eval("m.poleDistance(0)") == 1      # equator
    assert _eval("m.poleDistance(1)") == 0       # pole
    assert _eval("m.poleDistance(-1)") == 0      # pole
    val = _eval("m.poleDistance(0.5)")
    assert 0 <= val <= 1


def test_ripple_offset_zero_when_silent_or_not_speaking():
    assert _eval("m.rippleOffset(0.5, 1.0, 0, 1, m.LIQUID_CONFIG)") == 0  # no audio
    assert _eval("m.rippleOffset(0.5, 1.0, 0.8, 0, m.LIQUID_CONFIG)") == 0  # not speaking


def test_ripple_offset_bounded():
    bound = _eval(
        "(()=>{const c=m.LIQUID_CONFIG;return c.poleRippleAmp*c.audioReactivity*0.8;})()"
    )
    samples = _eval(
        "(()=>{const out=[];const c=m.LIQUID_CONFIG;"
        "for(let i=0;i<200;i++){const t=i*0.05;"
        "out.push(m.rippleOffset(i/199, t, 0.8, 1, c));}return out;})()"
    )
    assert all(abs(v) <= bound + 1e-9 for v in samples)


def test_audio_amplitude_from_bins():
    assert _eval("m.audioAmplitudeFromBins(null)") == 0
    assert _eval("m.audioAmplitudeFromBins([])") == 0
    val = _eval("m.audioAmplitudeFromBins([255,255,255,255])")
    assert val == pytest.approx(1.0)
    val = _eval("m.audioAmplitudeFromBins([0,255])")
    assert 0 <= val <= 1


def test_liquid_glsl_is_static_and_safe():
    vert = _eval("m.LIQUID_VERTEX_GLSL")
    frag = _eval("m.LIQUID_FRAGMENT_GLSL")
    assert "uTime" in vert
    assert "uFresnelPower" in frag
    assert "${" not in vert
    assert "${" not in frag


def test_liquid_config_finite():
    cfg = _eval("m.LIQUID_CONFIG")
    for key, value in cfg.items():
        if isinstance(value, dict):
            for sub in value.values():
                assert math.isfinite(sub)
        else:
            assert math.isfinite(value), f"{key} not finite"
