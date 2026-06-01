"""Unit tests for frontend/sphere-voronoi.js pure functions + GLSL safety.

Skipped automatically when Node.js is not installed.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

_MODULE = Path(__file__).resolve().parent.parent / "frontend" / "sphere-voronoi.js"

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


def test_pulse_rate_for_state_monotonic():
    idle = _eval("m.pulseRateForState('idle')")
    listening = _eval("m.pulseRateForState('listening')")
    thinking = _eval("m.pulseRateForState('thinking')")
    assert idle < listening < thinking
    assert _eval("m.pulseRateForState('transcribing')") == thinking
    assert _eval("m.pulseRateForState('totally-unknown')") == idle


def test_smooth_toward():
    assert _eval("m.smoothToward(0, 10, 5, 0)") == 0  # no-op at delta=0
    assert _eval("m.smoothToward(0, 10, 5, -1)") == 0
    mid = _eval("m.smoothToward(0, 10, 5, 0.1)")
    assert 0 < mid < 10
    converged = _eval(
        "(()=>{let v=0;for(let i=0;i<100;i++)v=m.smoothToward(v,10,5,0.1);return v;})()"
    )
    assert abs(converged - 10) < 0.1


def test_advance_pulse_phase_bounds_and_wrap():
    two_pi = 2 * math.pi
    for _ in range(50):
        pass
    samples = _eval(
        "(()=>{let p=0;const out=[];for(let i=0;i<200;i++){"
        "p=m.advancePulsePhase(p,1.5,0.05);out.push(p);}return out;})()"
    )
    assert all(0 <= v < two_pi + 1e-9 for v in samples)
    # Wrapping past 2π lands back in range.
    wrapped = _eval("m.advancePulsePhase(6.0, 5.0, 1.0)")
    assert 0 <= wrapped < two_pi


def test_voronoi_glsl_is_static_and_safe():
    glsl = _eval("m.VORONOI_GLSL_COMMON")
    assert "voronoiEdge" in glsl
    assert "${" not in glsl  # no template interpolation (SEC-002)


def test_voronoi_config_finite():
    cfg = _eval("m.VORONOI_CONFIG")
    for key, value in cfg.items():
        assert math.isfinite(value), f"{key} not finite"
