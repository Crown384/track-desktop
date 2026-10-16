"use strict";

// Pure presentation helpers. Never finalize a Track from the desktop countdown:
// TrackOS owns boundaries, outcomes, sync and permanent Sin Hours.
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
function normalizeActive(raw) {
  if (!raw || typeof raw !== "object" || !raw.trackId) return null;
  const resumedAt = Date.parse(raw.resumedAt);
  if (!Number.isFinite(resumedAt)) return null;
  return {
    id: String(raw.trackId),
    title: String(raw.trackTitle || "Active Track").slice(0, 120),
    mode: raw.trackMode === "count_up" ? "count_up" : "timed",
    resumedAt,
    requiredBefore: finiteNonNegative(raw.accumulatedRequiredMsBeforeResume),
    overtimeBefore: finiteNonNegative(raw.accumulatedOvertimeMsBeforeResume),
    target: finiteNonNegative(raw.targetDurationMs),
  };
}
function timerSnapshot(raw, now = Date.now()) {
  const active = normalizeActive(raw);
  if (!active) return null;
  const elapsed = Math.max(0, now - active.resumedAt);
  const focused = active.requiredBefore + active.overtimeBefore + elapsed;
  if (active.mode === "count_up") {
    return { ...active, milliseconds: focused, label: "FOCUS TIME", running: true, overtime: false };
  }
  const progressed = active.requiredBefore + elapsed;
  const remaining = Math.max(0, active.target - progressed);
  const overtime = Math.max(0, progressed - active.target) + active.overtimeBefore;
  return {
    ...active,
    // The public MCP snapshot does not expose the effective overtime policy.
    // Freeze at zero until TrackOS reconciles or returns a new authoritative state.
    milliseconds: remaining,
    label: remaining > 0 ? "TIME REMAINING" : "TARGET REACHED · AWAITING SYNC",
    running: true,
    overtime: remaining === 0 && overtime > 0,
  };
}
function formatDuration(ms) {
  const seconds = Math.floor(finiteNonNegative(ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (number) => String(number).padStart(2, "0");
  return hours > 0 ? [hours, minutes, secs].map(pad).join(":") : pad(minutes) + ":" + pad(secs);
}
function normalizeTracks(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((track) => track && typeof track.id === "string" && typeof track.title === "string")
    .slice(0, 100).map((track) => ({
      id: track.id,
      title: track.title.slice(0, 120),
      mode: ["timed", "count_up", "todo"].includes(track.mode) ? track.mode : "timed",
      state: String(track.state || track.status || ""),
      completed: track.completed === true || track.todoCompleted === true ||
        track.state === "completed" || track.state === "finalized",
      durationMs: finiteNonNegative(track.targetDurationMs ??
        (typeof track.targetDurationMinutes === "number" ? track.targetDurationMinutes * 60000 : 0)),
      color: /^#[0-9a-fA-F]{6}$/.test(track.color || "") ? track.color : null,
    }));
}
const TrackLogic = { normalizeActive, timerSnapshot, formatDuration, normalizeTracks };
if (typeof module !== "undefined" && module.exports) module.exports = TrackLogic;
else if (typeof window !== "undefined") window.TrackLogic = TrackLogic;
