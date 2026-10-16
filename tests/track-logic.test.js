"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { timerSnapshot, formatDuration, normalizeTracks } = require("../src/track/logic");

const base = {
  trackId: "focus",
  trackTitle: "Writing",
  trackMode: "timed",
  resumedAt: "2026-10-16T10:00:00.000Z",
  accumulatedRequiredMsBeforeResume: 120000,
  accumulatedOvertimeMsBeforeResume: 0,
  targetDurationMs: 600000,
};
const at = Date.parse("2026-10-16T10:05:00.000Z");
test("countdown includes required time accumulated before resume", () => {
  const s = timerSnapshot(base, at);
  assert.equal(s.milliseconds, 180000);
  assert.equal(s.overtime, false);
});
test("past target shows awaiting server reconciliation and never locally completes", () => {
  const s = timerSnapshot(base, at + 360000);
  assert.equal(s.label, "TARGET REACHED · AWAITING SYNC");
  assert.equal(s.milliseconds, 0);
  assert.equal(s.running, true);
});
test("count-up combines previous and current sessions", () => {
  const s = timerSnapshot({ ...base, trackMode: "count_up", targetDurationMs: 0 }, at);
  assert.equal(s.milliseconds, 420000);
  assert.equal(s.label, "FOCUS TIME");
});
test("invalid remote dates do not display fake active timers", () => {
  assert.equal(timerSnapshot({ ...base, resumedAt: "invalid" }), null);
});
test("durations keep correct hours and leading zeros", () => {
  assert.equal(formatDuration(3673000), "01:01:13");
  assert.equal(formatDuration(61000), "01:01");
});
test("untrusted track color is rejected and input list bounded", () => {
  const [track] = normalizeTracks([{ id: "a", title: "A", color: "red; background: blue" }]);
  assert.equal(track.color, null);
  assert.deepEqual(normalizeTracks(null), []);
});

const { isAllowedAuthNavigation } = require("../src/track/oauth-navigation");

const authorize = "https://track.pama.company/oauth/authorize?state=secure-abc&client_id=track-test";
const callback = "http://127.0.0.1:55123/callback";

test("desktop login accepts only TrackOS sign-in and expected OAuth callback", () => {
  assert.equal(isAllowedAuthNavigation(authorize, authorize, callback), true);
  assert.equal(isAllowedAuthNavigation("https://track.pama.company/oauth/authorize?state=secure-abc", authorize, callback), true);
  assert.equal(isAllowedAuthNavigation("http://127.0.0.1:55123/callback?state=secure-abc&code=opaque", authorize, callback), true);
});
test("desktop login rejects external pages, untrusted local ports and forged callback state", () => {
  assert.equal(isAllowedAuthNavigation("https://evil.example/sign-in", authorize, callback), false);
  assert.equal(isAllowedAuthNavigation("file:///C:/Windows/system.ini", authorize, callback), false);
  assert.equal(isAllowedAuthNavigation("javascript:alert(1)", authorize, callback), false);
  assert.equal(isAllowedAuthNavigation("http://localhost:55123/callback?state=secure-abc", authorize, callback), false);
  assert.equal(isAllowedAuthNavigation("http://127.0.0.1:55124/callback?state=secure-abc", authorize, callback), false);
  assert.equal(isAllowedAuthNavigation("http://127.0.0.1:55123/callback?state=forged&code=opaque", authorize, callback), false);
  assert.equal(isAllowedAuthNavigation("http://127.0.0.1:55123/other?state=secure-abc", authorize, callback), false);
});
