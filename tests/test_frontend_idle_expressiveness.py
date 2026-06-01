"""Unit tests for frontend/idle-expressiveness.js.

The module is imported in Node.js as an ES module and exercised through small
JSON-serialised snippets. Skipped automatically when Node.js is unavailable.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

_MODULE = Path(__file__).resolve().parent.parent / "frontend" / "idle-expressiveness.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="Node.js not installed"
)


def _eval(expr: str):
    url = _MODULE.as_uri()
    script = (
        f"import * as mod from {json.dumps(url)};"
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


def test_draw_interval_bounds():
    assert _eval("mod.drawInterval(() => 0, 4, 12)") == 4
    assert _eval("mod.drawInterval(() => 0.999999, 4, 12)") == pytest.approx(11.999992)
    samples = _eval(
        "Array.from({length:101},(_,i)=>mod.drawInterval(() => i / 100, 10, 20))"
    )
    assert all(10 <= value <= 20 for value in samples)


def test_pick_weighted_kind_deterministic_and_distributed():
    assert _eval(
        "mod.pickWeightedKind(() => 0, { pulse: 0.4, orbBrighten: 0.35, ripple: 0.25 })"
    ) == "pulse"
    assert _eval(
        "mod.pickWeightedKind(() => 0.6, { pulse: 0.4, orbBrighten: 0.35, ripple: 0.25 })"
    ) == "orbBrighten"
    assert _eval(
        "mod.pickWeightedKind(() => 0.95, { pulse: 0.4, orbBrighten: 0.35, ripple: 0.25 })"
    ) == "ripple"
    counts = _eval(
        "(() => {"
        "  const weights = { pulse: 0.4, orbBrighten: 0.35, ripple: 0.25 };"
        "  const counts = { pulse: 0, orbBrighten: 0, ripple: 0 };"
        "  const values = Array.from({ length: 10000 }, (_, i) => (i + 0.5) / 10000);"
        "  let idx = 0;"
        "  const rng = () => values[idx++ % values.length];"
        "  for (let i = 0; i < values.length; i++) counts[mod.pickWeightedKind(rng, weights)] += 1;"
        "  return counts;"
        "})()"
    )
    assert counts["pulse"] / 10000 == pytest.approx(0.4, abs=0.02)
    assert counts["orbBrighten"] / 10000 == pytest.approx(0.35, abs=0.02)
    assert counts["ripple"] / 10000 == pytest.approx(0.25, abs=0.02)


def test_event_envelope_shape():
    assert _eval("mod.eventEnvelope(0)") == 0
    assert _eval("mod.eventEnvelope(1)") == 0
    assert _eval("mod.eventEnvelope(-1)") == 0
    assert _eval("mod.eventEnvelope(2)") == 0
    assert _eval("mod.eventEnvelope(0.5)") == pytest.approx(1.0)
    samples = _eval("Array.from({length:21},(_,i)=>mod.eventEnvelope(i / 20))")
    assert all(0 <= value <= 1 for value in samples)
    assert max(samples) == pytest.approx(samples[10])


def test_blink_envelope_shape():
    assert _eval("mod.blinkEnvelope(0)") == 0
    assert _eval("mod.blinkEnvelope(1)") == 0
    samples = _eval("Array.from({length:41},(_,i)=>mod.blinkEnvelope(i / 40))")
    assert all(0 <= value <= 1 for value in samples)
    assert max(samples) > 0.99
    assert samples[1] > samples[-2]


def test_idle_scheduler_lifecycle_and_independence():
    result = _eval(
        "(() => {"
        "  const scheduler = mod.makeIdleScheduler(mod.IDLE_FX_CONFIG, () => 0);"
        "  const timeline = [];"
        "  timeline.push(scheduler.update(3999, true));"
        "  timeline.push(scheduler.update(1, true));"
        "  timeline.push(scheduler.update(900, true));"
        "  timeline.push(scheduler.update(1100, true));"
        "  timeline.push(scheduler.update(2000, true));"
        "  timeline.push(scheduler.update(0, false));"
        "  timeline.push(scheduler.update(4000, true));"
        "  return timeline;"
        "})()"
    )
    assert result[0]["event"] is None
    assert result[0]["blink"] is None
    assert result[1]["event"]["kind"] == "pulse"
    assert result[1]["event"]["seq"] == 1
    assert result[1]["blink"] is None
    assert result[2]["event"] is None
    assert result[3]["event"] is None
    assert result[3]["blink"]["seq"] == 1
    assert result[4]["event"] is None
    assert result[4]["blink"] is None
    assert result[5]["event"] is None
    assert result[5]["blink"] is None
    assert result[6]["event"]["seq"] == 2


def test_idle_scheduler_reset_and_inactive_update_produce_no_events():
    result = _eval(
        "(() => {"
        "  const scheduler = mod.makeIdleScheduler(mod.IDLE_FX_CONFIG, () => 0);"
        "  const before = scheduler.update(4000, true);"
        "  scheduler.reset();"
        "  const afterReset = scheduler.update(0, true);"
        "  const inactive = scheduler.update(100000, false);"
        "  return { before, afterReset, inactive };"
        "})()"
    )
    assert result["before"]["event"]["seq"] == 1
    assert result["afterReset"]["event"] is None
    assert result["afterReset"]["blink"] is None
    assert result["inactive"]["event"] is None
    assert result["inactive"]["blink"] is None


def test_idle_fx_config_and_representative_outputs_are_finite():
    cfg = _eval("mod.IDLE_FX_CONFIG")
    for key in (
        "microMinDelayMs", "microMaxDelayMs", "pulseDurationMs",
        "orbBrightenDurationMs", "rippleDurationMs", "blinkMinDelayMs",
        "blinkMaxDelayMs", "blinkDurationMs", "pulseAmp",
        "orbBrightenAmp", "orbOpacityAmp", "rippleAmp",
        "rippleFalloffPow", "blinkDimFactor", "blinkGlowFactor",
        "blinkRimOpacityFactor",
    ):
        assert isinstance(cfg[key], (int, float))
        assert cfg[key] == pytest.approx(cfg[key])
    assert sum(cfg["kindWeights"].values()) > 0

    outputs = _eval(
        "({"
        "  draw: mod.drawInterval(() => 0.25, 4, 12),"
        "  pick: mod.pickWeightedKind(() => 0.7, { pulse: 1, ripple: 1 }),"
        "  eventEnv: mod.eventEnvelope(0.25),"
        "  blinkEnv: mod.blinkEnvelope(0.25)"
        "})"
    )
    assert outputs["draw"] == pytest.approx(6.0)
    assert outputs["pick"] in {"pulse", "ripple"}
    assert outputs["eventEnv"] == pytest.approx(outputs["eventEnv"])
    assert outputs["blinkEnv"] == pytest.approx(outputs["blinkEnv"])