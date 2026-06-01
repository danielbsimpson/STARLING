"""Unit tests for frontend/ambient-fx.js.

Pure-function helpers (state → glow colour, state → bloom strength, exponential
smoothing, frame throttle predicate) and structural guards (GLSL static-source
requirement, config key completeness) are evaluated by importing the ES module
in Node.js and serialising results as JSON.

Visual acceptance criteria (TEST-010, TEST-011, TEST-012) are manual/browser
checks documented in the test-module docstring and are not automated here.

Skipped automatically when Node.js is not installed on the test host, consistent
with tests/test_frontend_animation_easings.py.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

_AMBIENT_FX = Path(__file__).resolve().parent.parent / "frontend" / "ambient-fx.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js not installed"
)


def _eval(expr: str):
    """Import ambient-fx.js in Node ESM context, evaluate *expr*, return parsed JSON."""
    url = _AMBIENT_FX.as_uri()
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


# ── TEST-001 / glowColorForState ──────────────────────────────────────────────

def test_glow_color_idle_is_blue_dominant():
    """idle returns the cool-blue anchor — blue channel must be the highest."""
    c = _eval("e.glowColorForState('idle')")
    assert c["b"] == max(c["r"], c["g"], c["b"]), "idle colour: blue channel must dominate"
    assert all(0 <= v <= 1 for v in c.values()), "idle colour channels must be in [0,1]"


def test_glow_color_speaking_is_amber_dominant():
    """speaking returns the warm-amber anchor — red channel must be the highest."""
    c = _eval("e.glowColorForState('speaking')")
    assert c["r"] == max(c["r"], c["g"], c["b"]), "speaking colour: red channel must dominate"
    assert all(0 <= v <= 1 for v in c.values()), "speaking colour channels must be in [0,1]"


def test_glow_color_unknown_falls_back_to_idle():
    """Unknown states must fall back to the idle cool-blue anchor."""
    idle    = _eval("e.glowColorForState('idle')")
    unknown = _eval("e.glowColorForState('__unknown_state__')")
    assert unknown == idle, "unknown state must return the idle colour"


def test_glow_color_channels_in_range_for_all_states():
    """Every mapped state must produce colour channels strictly within [0, 1]."""
    states = ("idle", "listening", "thinking", "transcribing", "speaking", "warmup", "error")
    for state in states:
        c = _eval(f"e.glowColorForState({json.dumps(state)})")
        assert all(0 <= v <= 1 for v in c.values()), (
            f"glowColorForState('{state}'): channel out of [0,1]: {c}"
        )


# ── TEST-002 / bloomStrengthForState ─────────────────────────────────────────

def test_bloom_strength_active_states_return_active_value():
    """Active interaction states must return bloomStrengthActive."""
    active_target = _eval("e.GLOW_CONFIG.bloomStrengthActive")
    for state in ("listening", "thinking", "transcribing", "speaking"):
        v = _eval(f"e.bloomStrengthForState({json.dumps(state)})")
        assert v == pytest.approx(active_target), (
            f"bloomStrengthForState('{state}') should equal bloomStrengthActive"
        )


def test_bloom_strength_idle_and_unknown_return_idle_value():
    """idle and unknown states must return bloomStrengthIdle."""
    idle_target = _eval("e.GLOW_CONFIG.bloomStrengthIdle")
    for state in ("idle", "__unknown__"):
        v = _eval(f"e.bloomStrengthForState({json.dumps(state)})")
        assert v == pytest.approx(idle_target), (
            f"bloomStrengthForState('{state}') should equal bloomStrengthIdle"
        )


def test_bloom_strength_active_greater_than_idle():
    """bloomStrengthActive must be strictly greater than bloomStrengthIdle."""
    active = _eval("e.GLOW_CONFIG.bloomStrengthActive")
    idle   = _eval("e.GLOW_CONFIG.bloomStrengthIdle")
    assert active > idle, "active bloom strength must exceed idle bloom strength"


# ── TEST-003 / smoothToward ───────────────────────────────────────────────────

def test_smooth_toward_noop_at_zero_delta():
    """delta=0 must return current unchanged."""
    result = _eval("e.smoothToward(0.3, 0.9, 3.0, 0)")
    assert result == pytest.approx(0.3), "smoothToward with delta=0 must be a no-op"


def test_smooth_toward_converges_within_one_percent():
    """100 iterations of delta=0.016 (≈60 fps) must converge within 1% of target."""
    url = _AMBIENT_FX.as_uri()
    script = (
        f"import * as e from {json.dumps(url)};"
        "let v = 0.0;"
        "for (let i = 0; i < 100; i++) v = e.smoothToward(v, 1.0, 3.0, 0.016);"
        "console.log(JSON.stringify(v));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, result.stderr
    v = json.loads(result.stdout.strip())
    assert abs(v - 1.0) < 0.01, f"smoothToward did not converge: got {v}, expected ≈1.0"


def test_smooth_toward_moves_strictly_toward_target():
    """For positive finite delta, result must be strictly between current and target."""
    result = _eval("e.smoothToward(0.0, 1.0, 3.0, 0.016)")
    assert 0.0 < result < 1.0, "smoothToward must move strictly toward target"


# ── TEST-004 / smoothColor ────────────────────────────────────────────────────

def test_smooth_color_channels_stay_in_range():
    """After 60 easing steps all colour channels must remain within [0, 1]."""
    result = _eval(
        "(() => {"
        "  const cur = {r: 0.0, g: 0.5, b: 1.0};"
        "  const tgt = {r: 1.0, g: 0.0, b: 0.5};"
        "  for (let i = 0; i < 60; i++) e.smoothColor(cur, tgt, 3.0, 0.016);"
        "  return cur;"
        "})()"
    )
    for ch, v in result.items():
        assert 0.0 <= v <= 1.0, f"smoothColor channel '{ch}' out of [0,1]: {v}"


def test_smooth_color_converges_each_channel():
    """All channels must converge toward the target after many iterations."""
    result = _eval(
        "(() => {"
        "  const cur = {r: 0.0, g: 0.0, b: 0.0};"
        "  const tgt = {r: 1.0, g: 1.0, b: 1.0};"
        "  for (let i = 0; i < 200; i++) e.smoothColor(cur, tgt, 3.0, 0.016);"
        "  return cur;"
        "})()"
    )
    for ch, v in result.items():
        assert abs(v - 1.0) < 0.01, f"smoothColor channel '{ch}' did not converge: {v}"


# ── TEST-005 / shouldRenderFrame ─────────────────────────────────────────────

def test_should_render_frame_false_before_threshold():
    """Returns false when elapsed time is less than throttleMs."""
    assert _eval("e.shouldRenderFrame(1000, 1010, 33)") is False


def test_should_render_frame_true_at_threshold():
    """Returns true when elapsed time equals throttleMs exactly."""
    assert _eval("e.shouldRenderFrame(1000, 1033, 33)") is True


def test_should_render_frame_true_past_threshold():
    """Returns true when elapsed time exceeds throttleMs."""
    assert _eval("e.shouldRenderFrame(1000, 1050, 33)") is True


def test_should_render_frame_boundary_one_ms_before():
    """Returns false at exactly one millisecond before the threshold."""
    assert _eval("e.shouldRenderFrame(1000, 1032, 33)") is False


# ── TEST-006 / NEBULA_GLSL static-source guard (SEC-002) ─────────────────────

def test_nebula_glsl_contains_uniform_token():
    """NEBULA_GLSL must contain the expected uniform name 'uNebTime'."""
    glsl = _eval("e.NEBULA_GLSL")
    assert "uNebTime" in glsl, "NEBULA_GLSL missing expected uniform 'uNebTime'"


def test_nebula_glsl_no_template_interpolation():
    """NEBULA_GLSL must not contain '${' — SEC-002 static-source regression guard."""
    glsl = _eval("e.NEBULA_GLSL")
    assert "${" not in glsl, (
        "NEBULA_GLSL contains template interpolation marker '${' — violates SEC-002"
    )


def test_nebula_glsl_contains_expected_tokens():
    """NEBULA_GLSL must reference all declared uniforms and the vUv varying."""
    glsl = _eval("e.NEBULA_GLSL")
    for token in ("uNebTime", "uNebScale", "uNebBase", "uNebAccent", "uNebBrightness", "vUv"):
        assert token in glsl, f"NEBULA_GLSL missing expected token '{token}'"


# ── TEST-007 / config completeness ───────────────────────────────────────────

def test_glow_config_scalar_keys_present_and_finite():
    """GLOW_CONFIG must expose every documented scalar key with finite values."""
    cfg = _eval("e.GLOW_CONFIG")
    required_scalar_keys = (
        "bloomStrengthIdle", "bloomStrengthActive",
        "bloomRadius", "bloomThreshold",
        "colorSmoothing", "strengthSmoothing",
    )
    for key in required_scalar_keys:
        assert key in cfg, f"GLOW_CONFIG missing key '{key}'"
        v = cfg[key]
        assert isinstance(v, (int, float)), f"GLOW_CONFIG.{key} is not numeric: {v!r}"
        assert v == v and abs(v) != float("inf"), f"GLOW_CONFIG.{key} is not finite: {v}"


def test_glow_config_colour_anchors_present_and_valid():
    """GLOW_CONFIG colour anchors must exist and have r/g/b channels."""
    cfg = _eval("e.GLOW_CONFIG")
    for color_key in ("idleColor", "listenColor", "thinkColor", "speakColor"):
        assert color_key in cfg, f"GLOW_CONFIG missing colour anchor '{color_key}'"
        for ch in ("r", "g", "b"):
            assert ch in cfg[color_key], (
                f"GLOW_CONFIG.{color_key} missing channel '{ch}'"
            )


def test_nebula_config_scalar_keys_present_and_finite():
    """NEBULA_CONFIG must expose every documented scalar key with finite values."""
    cfg = _eval("e.NEBULA_CONFIG")
    required_scalar_keys = ("driftSpeed", "scale", "brightness", "throttleMs", "pixelRatio")
    for key in required_scalar_keys:
        assert key in cfg, f"NEBULA_CONFIG missing key '{key}'"
        v = cfg[key]
        assert isinstance(v, (int, float)), f"NEBULA_CONFIG.{key} is not numeric: {v!r}"
        assert v == v and abs(v) != float("inf"), f"NEBULA_CONFIG.{key} is not finite: {v}"


def test_nebula_config_colour_keys_present_and_valid():
    """NEBULA_CONFIG colour keys must exist and have r/g/b channels."""
    cfg = _eval("e.NEBULA_CONFIG")
    for color_key in ("baseColor", "accentColor"):
        assert color_key in cfg, f"NEBULA_CONFIG missing colour key '{color_key}'"
        for ch in ("r", "g", "b"):
            assert ch in cfg[color_key], (
                f"NEBULA_CONFIG.{color_key} missing channel '{ch}'"
            )


# ── TEST-008 / NaN / Infinity regression guard ────────────────────────────────

def test_no_nan_or_infinity_for_representative_inputs():
    """Exported functions must not return NaN or Infinity for finite inputs."""
    results = _eval(
        "["
        "  e.smoothToward(0.5, 1.0, 3.0, 0.016),"
        "  e.smoothToward(0.0, 0.0, 3.0, 0.016),"
        "  e.smoothToward(1.0, 1.0, 0.0, 0.016),"
        "  e.bloomStrengthForState('idle'),"
        "  e.bloomStrengthForState('speaking'),"
        "  e.bloomStrengthForState('__unknown__'),"
        "]"
    )
    for v in results:
        assert isinstance(v, (int, float)), f"expected numeric, got {v!r}"
        assert v == v, f"NaN produced for representative input"
        assert abs(v) != float("inf"), f"Infinity produced for representative input"
