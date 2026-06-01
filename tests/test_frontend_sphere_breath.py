"""Unit tests for frontend/sphere-breath.js.

Each function is evaluated by importing the ES module in Node.js and
serialising the result back as JSON. Skipped automatically when Node.js is
not installed on the test host.

Manual/visual acceptance (not automated):
  - The silent idle sphere visibly but subtly breathes on a ~4 s cycle.
  - Breath deepens slightly in active states (listening/thinking/speaking).
  - While listening the surface dents inward toward the mic point in time
    with incoming audio.
  - Under prefers-reduced-motion the surface is static and the ripple is absent.
  - Lifecycle animations are visually unchanged.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

_MODULE = Path(__file__).resolve().parent.parent / "frontend" / "sphere-breath.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js not installed"
)


def _eval(expr: str):
    """Evaluate a JS expression against the sphere-breath module, return parsed JSON."""
    url = _MODULE.as_uri()
    script = (
        f"import * as sb from {json.dumps(url)};"
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


# ── BREATH_CONFIG ─────────────────────────────────────────────────────────────

def test_breath_config_keys():
    """TEST-009: BREATH_CONFIG exposes every documented key with finite values."""
    cfg = _eval("sb.BREATH_CONFIG")
    for key in ("breathHz", "idleAmp", "activeAmp", "ampSmoothing",
                "rippleDepth", "rippleFalloff", "rippleGainSmoothing"):
        assert key in cfg, f"BREATH_CONFIG missing '{key}'"
        assert math.isfinite(cfg[key]), f"BREATH_CONFIG.{key} is not finite"
    for axis in ("x", "y", "z"):
        assert axis in cfg["micDir"], f"BREATH_CONFIG.micDir missing '{axis}'"
        assert math.isfinite(cfg["micDir"][axis])

    # activeAmp must exceed idleAmp (TEST-001)
    assert cfg["activeAmp"] > cfg["idleAmp"]


# ── breathAmplitudeForState ───────────────────────────────────────────────────

def test_breath_amplitude_active_states():
    """TEST-001: active states return activeAmp."""
    active_amp = _eval("sb.BREATH_CONFIG.activeAmp")
    for state in ("listening", "thinking", "transcribing", "speaking", "warmup"):
        val = _eval(f"sb.breathAmplitudeForState({json.dumps(state)})")
        assert val == pytest.approx(active_amp), f"state={state!r} did not return activeAmp"


def test_breath_amplitude_idle_states():
    """TEST-001: idle and unknown states return idleAmp."""
    idle_amp = _eval("sb.BREATH_CONFIG.idleAmp")
    for state in ("idle", "error", "unknown", ""):
        val = _eval(f"sb.breathAmplitudeForState({json.dumps(state)})")
        assert val == pytest.approx(idle_amp), f"state={state!r} did not return idleAmp"


# ── breathDisplacement ────────────────────────────────────────────────────────

def test_breath_displacement_bounds():
    """TEST-002: breathDisplacement stays within [-amplitude, +amplitude]."""
    amp = 0.022
    # Sample over one full cycle
    vals = _eval(
        f"Array.from({{length:200}},(_,i)=>"
        f"sb.breathDisplacement(i/200*2*Math.PI, {amp}))"
    )
    for v in vals:
        assert -amp - 1e-9 <= v <= amp + 1e-9, f"breathDisplacement out of range: {v}"


def test_breath_displacement_no_nan():
    """TEST-010: breathDisplacement never returns NaN/Infinity."""
    result = _eval("sb.breathDisplacement(1.5, 0.015)")
    assert math.isfinite(result)


# ── advanceBreathPhase ────────────────────────────────────────────────────────

def test_advance_breath_phase_range():
    """TEST-003: phase is always in [0, 2π)."""
    phases = _eval(
        "Array.from({length:500},(_,i)=>"
        "Array.from({length:i+1}).reduce(p=>sb.advanceBreathPhase(p,0.25,1/60),0))"
    )
    TWO_PI = 2 * math.pi
    for p in phases:
        assert 0 <= p < TWO_PI + 1e-9, f"phase out of [0, 2π): {p}"


def test_advance_breath_phase_zero_delta():
    """TEST-003: delta=0 leaves phase unchanged."""
    result = _eval("sb.advanceBreathPhase(1.23, 0.25, 0)")
    assert result == pytest.approx(1.23)


def test_advance_breath_phase_wraps():
    """TEST-003: phase wraps correctly past 2π."""
    # Start near 2π, one step should wrap
    near_two_pi = 2 * math.pi - 0.001
    result = _eval(f"sb.advanceBreathPhase({near_two_pi}, 0.25, 0.1)")
    assert 0 <= result < 2 * math.pi + 1e-9


def test_advance_breath_phase_four_second_cycle():
    """TEST-004: accumulating at breathHz=0.25 reaches 2π after ~4 s."""
    # Sum 240 frames of delta=1/60 → 4 s total; phase should be close to 2π (wrapped ~ 0)
    final_phase = _eval(
        "Array.from({length:240}).reduce(p=>sb.advanceBreathPhase(p,0.25,1/60),0)"
    )
    TWO_PI = 2 * math.pi
    # After exactly 4 s the phase should be back near 0 (wrapped from 2π)
    assert abs(final_phase) < 0.05 or abs(final_phase - TWO_PI) < 0.05


# ── rippleWeight ──────────────────────────────────────────────────────────────

def test_ripple_weight_aligned():
    """TEST-005: vertex aligned with micDir returns ≈ 1."""
    result = _eval(
        "sb.rippleWeight(sb.BREATH_CONFIG.micDir, sb.BREATH_CONFIG.micDir, sb.BREATH_CONFIG.rippleFalloff)"
    )
    assert result == pytest.approx(1.0, abs=1e-6)


def test_ripple_weight_opposite():
    """TEST-005: vertex opposite micDir returns 0."""
    result = _eval(
        "sb.rippleWeight("
        "  {x:-sb.BREATH_CONFIG.micDir.x, y:-sb.BREATH_CONFIG.micDir.y, z:-sb.BREATH_CONFIG.micDir.z},"
        "  sb.BREATH_CONFIG.micDir,"
        "  sb.BREATH_CONFIG.rippleFalloff"
        ")"
    )
    assert result == pytest.approx(0.0, abs=1e-9)


def test_ripple_weight_range():
    """TEST-005: weight is always within [0, 1]."""
    weights = _eval(
        "Array.from({length:100},(_,i)=>{"
        "  const a=i/99*2*Math.PI;"
        "  return sb.rippleWeight({x:Math.cos(a),y:Math.sin(a),z:0},"
        "    sb.BREATH_CONFIG.micDir, sb.BREATH_CONFIG.rippleFalloff);"
        "})"
    )
    for w in weights:
        assert 0 - 1e-9 <= w <= 1 + 1e-9, f"rippleWeight out of [0,1]: {w}"


def test_ripple_weight_falloff_narrows_lobe():
    """TEST-006: increasing falloff narrows the lobe — weight at 45° decreases as falloff grows."""
    # Vertex at 45° from micDir  (same z, rotate in xz-plane)
    vertex_45 = "{x:0.707,y:0,z:0.707}"
    mic       = "{x:0,y:0,z:1}"
    w_low  = _eval(f"sb.rippleWeight({vertex_45}, {mic}, 1.0)")
    w_mid  = _eval(f"sb.rippleWeight({vertex_45}, {mic}, 2.0)")
    w_high = _eval(f"sb.rippleWeight({vertex_45}, {mic}, 4.0)")
    assert w_low > w_mid > w_high


def test_ripple_weight_no_nan():
    """TEST-010: rippleWeight never returns NaN."""
    result = _eval("sb.rippleWeight({x:0.5,y:0.3,z:0.8},{x:0,y:-0.6,z:0.8},2.2)")
    assert math.isfinite(result)


# ── rippleDisplacement ────────────────────────────────────────────────────────

def test_ripple_displacement_is_inward():
    """TEST-007: result ≤ 0 (inward) for non-negative inputs."""
    result = _eval("sb.rippleDisplacement(0.8, 0.5, 0.9, sb.BREATH_CONFIG.rippleDepth)")
    assert result <= 0


def test_ripple_displacement_zero_weight():
    """TEST-007: result is 0 when weight is 0."""
    result = _eval("sb.rippleDisplacement(0, 0.5, 0.9, sb.BREATH_CONFIG.rippleDepth)")
    assert result == pytest.approx(0.0)


def test_ripple_displacement_zero_gain():
    """TEST-007: result is 0 when gain is 0."""
    result = _eval("sb.rippleDisplacement(0.8, 0.5, 0, sb.BREATH_CONFIG.rippleDepth)")
    assert result == pytest.approx(0.0)


def test_ripple_displacement_linear_weight():
    """TEST-007: magnitude scales linearly with weight."""
    d1 = _eval("sb.rippleDisplacement(0.5, 1.0, 1.0, 0.06)")
    d2 = _eval("sb.rippleDisplacement(1.0, 1.0, 1.0, 0.06)")
    assert d2 == pytest.approx(d1 * 2, rel=1e-6)


def test_ripple_displacement_no_nan():
    """TEST-010: rippleDisplacement never returns NaN."""
    result = _eval("sb.rippleDisplacement(0.7, 0.4, 0.6, 0.06)")
    assert math.isfinite(result)


# ── smoothToward ──────────────────────────────────────────────────────────────

def test_smooth_toward_zero_delta():
    """TEST-008: delta=0 returns current unchanged."""
    result = _eval("sb.smoothToward(3.14, 10.0, 2.0, 0)")
    assert result == pytest.approx(3.14)


def test_smooth_toward_between_current_and_target():
    """TEST-008: result is strictly between current and target for positive delta."""
    current, target = 0.0, 1.0
    result = _eval(f"sb.smoothToward({current}, {target}, 5.0, 0.016)")
    assert current < result < target


def test_smooth_toward_converges():
    """TEST-008: converges within 1% of target over 100 iterations at delta=0.016."""
    target = 1.0
    final = _eval(
        f"Array.from({{length:100}}).reduce(v=>sb.smoothToward(v,{target},5.0,0.016),0.0)"
    )
    assert abs(final - target) < 0.01


def test_smooth_toward_no_nan():
    """TEST-010: smoothToward never returns NaN."""
    result = _eval("sb.smoothToward(0.5, 1.0, 3.0, 0.016)")
    assert math.isfinite(result)
