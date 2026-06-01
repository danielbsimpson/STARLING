"""Unit tests for frontend/orb-behavior.js.

The pure orb-behaviour math (state→warmth mapping, temperature→RGB ramp, boid
steering / integration, and chase scheduling) is exercised by importing the ES
module in Node.js and serialising results back as JSON. Skipped automatically
when Node.js is not installed on the test host, mirroring
test_frontend_animation_easings.py.

Manual / visual acceptance (NOT automated): idle orbs drift slowly out of phase
in cool blue-white; listening tightens orbits, equalises speed, leans toward the
mic and shifts cyan; thinking jitters with occasional two-orb chases in warm
gold; speaking pulses spacing with the voice; under prefers-reduced-motion only
the calm idle drift occurs.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

_ORB = Path(__file__).resolve().parent.parent / "frontend" / "orb-behavior.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js not installed"
)


def _eval(expr: str):
    """Evaluate a JS expression against the orb-behavior module, return JSON."""
    url = _ORB.as_uri()
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


# ── warmthForState (TEST-001 / TEST-002) ──────────────────────────────────────
def test_warmth_monotonic_across_states():
    idle = _eval("m.warmthForState('idle')")
    listening = _eval("m.warmthForState('listening')")
    thinking = _eval("m.warmthForState('thinking')")
    transcribing = _eval("m.warmthForState('transcribing')")
    speaking = _eval("m.warmthForState('speaking')")
    assert idle < listening < thinking <= speaking
    assert transcribing == thinking


def test_warmth_unknown_state_is_idle_cool():
    assert _eval("m.warmthForState('__nope__')") == 0.0


# ── temperatureToRGB (TEST-003 / TEST-004) ────────────────────────────────────
def test_temperature_cool_anchor_blue_dominant():
    c = _eval("m.temperatureToRGB(0)")
    assert c["b"] >= c["r"] and c["b"] >= c["g"]


def test_temperature_gold_anchor_red_dominant():
    c = _eval("m.temperatureToRGB(1)")
    assert c["r"] >= c["g"] and c["r"] >= c["b"]


def test_temperature_channels_in_range_with_ember():
    samples = _eval(
        "Array.from({length:21},(_,i)=>m.temperatureToRGB(i/20, 0.2))"
        ".concat(Array.from({length:21},(_,i)=>m.temperatureToRGB(i/20, -0.3)))"
    )
    for c in samples:
        for ch in ("r", "g", "b"):
            assert 0.0 <= c[ch] <= 1.0


# ── steerOrb (TEST-005 / TEST-006 / TEST-007) ─────────────────────────────────
def test_steer_no_neighbors_points_toward_target():
    # cur away from target, no neighbours → acceleration dotted with (target-cur)>0
    dot = _eval(
        "(()=>{const cur={x:1,y:0,z:0},tgt={x:1.6,y:0,z:0};"
        "const a=m.steerOrb(cur,tgt,[],m.ORB_BEHAVIOR_CONFIG);"
        "return a.x*(tgt.x-cur.x)+a.y*(tgt.y-cur.y)+a.z*(tgt.z-cur.z);})()"
    )
    assert dot > 0


def test_steer_separation_is_mutually_repulsive():
    # Two orbs within sepRadius, target == cur so only separation acts.
    res = _eval(
        "(()=>{const A={x:0,y:0,z:0},B={x:0.2,y:0,z:0};"
        "const aA=m.steerOrb(A,A,[B],m.ORB_BEHAVIOR_CONFIG);"
        "const aB=m.steerOrb(B,B,[A],m.ORB_BEHAVIOR_CONFIG);"
        "return {ax:aA.x, bx:aB.x};})()"
    )
    # A pushed toward -x, B pushed toward +x — opposite signs.
    assert res["ax"] < 0 < res["bx"]


def test_steer_magnitude_clamped_and_finite():
    res = _eval(
        "(()=>{const cur={x:0.01,y:0,z:0},tgt={x:50,y:50,z:50};"
        "const a=m.steerOrb(cur,tgt,[],m.ORB_BEHAVIOR_CONFIG);"
        "const mag=Math.sqrt(a.x*a.x+a.y*a.y+a.z*a.z);"
        "return {mag, finite: Number.isFinite(a.x)&&Number.isFinite(a.y)&&Number.isFinite(a.z)};})()"
    )
    assert res["finite"] is True
    assert res["mag"] <= _eval("m.ORB_BEHAVIOR_CONFIG.maxSteer") + 1e-9


# ── integrateOrbPosition (TEST-008 / TEST-009) ────────────────────────────────
def test_integrate_zero_delta_unchanged():
    res = _eval(
        "(()=>{const cur={x:1,y:2,z:3},vel={x:4,y:5,z:6},acc={x:7,y:8,z:9};"
        "const o=m.integrateOrbPosition(cur,vel,acc,0,6);"
        "return o;})()"
    )
    assert res["pos"] == {"x": 1, "y": 2, "z": 3}
    assert res["vel"] == {"x": 4, "y": 5, "z": 6}


def test_integrate_converges_toward_target():
    # Drive accel toward a fixed target each step (via steerOrb) → position
    # converges to the target's orbit point (the integrator's only fixed point)
    # and stays finite. The default soft pathWeight settles asymptotically, so
    # the check uses a long horizon.
    res = _eval(
        "(()=>{let pos={x:1.0,y:0,z:0},vel={x:0,y:0,z:0};"
        "const tgt={x:1.6,y:0,z:0};const cfg=m.ORB_BEHAVIOR_CONFIG;"
        "for(let s=0;s<800;s++){"
        "const a=m.steerOrb(pos,tgt,[],cfg);"
        "const o=m.integrateOrbPosition(pos,vel,a,1/60,cfg.posSmoothing);"
        "pos=o.pos;vel=o.vel;}"
        "return {x:pos.x, finite:Number.isFinite(pos.x)};})()"
    )
    assert res["finite"] is True
    assert abs(res["x"] - 1.6) <= 0.016  # within ~1% of target


# ── chase scheduling (TEST-010) ───────────────────────────────────────────────
def test_should_start_chase_deterministic():
    assert _eval("m.shouldStartChase(()=>0, 0.5)") is True
    assert _eval("m.shouldStartChase(()=>0, 0.0)") is False
    assert _eval("m.shouldStartChase(()=>0.99, 0.004)") is False


def test_pick_chase_pair_distinct_in_range():
    res = _eval("m.pickChasePair(()=>0.5, 7)")
    assert isinstance(res, list) and len(res) == 2
    assert res[0] != res[1]
    assert 0 <= res[0] < 7 and 0 <= res[1] < 7


# ── config sanity (TEST-011) ──────────────────────────────────────────────────
def test_config_keys_present_and_finite():
    cfg = _eval("m.ORB_BEHAVIOR_CONFIG")
    numeric_keys = [
        "sepRadius", "sepWeight", "pathWeight", "shellWeight", "maxSteer",
        "posSmoothing", "idleRadiusMult", "listenRadiusMult", "speakPulseAmount",
        "thinkJitterAmp", "chaseProb", "chaseDurationMs", "tempSmoothing",
        "emberSpread",
    ]
    for k in numeric_keys:
        assert k in cfg, f"missing config key {k}"
        assert isinstance(cfg[k], (int, float))
    for axis in ("x", "y", "z"):
        assert isinstance(cfg["micDir"][axis], (int, float))
