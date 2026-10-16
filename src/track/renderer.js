"use strict";
(() => {
  const API = window.trackDesktop;
  const logic = window.TrackLogic;
  const mode = new URLSearchParams(window.location.search).get("mode") === "controls" ? "controls" : "wallpaper";
  const $ = (id) => document.getElementById(id);
  let state = { status: "disconnected", active: null, tracks: [], stale: false, date: null, error: null };
  let pending = false;
  let actionError = null;
  $("wallpaper").classList.toggle("hidden", mode === "controls");
  $("controls").classList.toggle("hidden", mode !== "controls");

  function text(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value ?? "");
  }
  function statusLabel() {
    return ({ connected: "Connected", disconnected: "Not connected", connecting: "Connecting", offline: "Offline · retrying" })[state.status] || "Connecting";
  }
  function currentSnapshot() {
    if (state.status === "disconnected") return null;
    return logic.timerSnapshot(state.active, Date.now());
  }
  function drawClock() {
    const d = new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    text("wall-clock", time);
    text("wall-date", d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }));
    const timer = currentSnapshot();
    const formatted = timer ? logic.formatDuration(timer.milliseconds) : time;
    text("wall-time", formatted);
    text("panel-time", timer ? formatted : "00:00");
    text("wall-kicker", timer ? timer.label : "Stay intentional");
    text("panel-kicker", timer ? timer.label : "Today's focus");
    text("wall-title", timer ? timer.title : "Your time. Your focus.");
    text("panel-title", timer ? timer.title : "Ready when you are");
    text("panel-caption", timer ? timer.label : "No active Track");
    text("wall-subtitle", timer ? (state.stale ? "Offline · showing last known timer" : "Your focus is in motion.") :
      state.status === "disconnected" ? "Connect your Track account to see your live focus." :
      state.stale ? "Could not reach Track · showing last known status." : "Choose a Track to begin.");
    if (timer && timer.mode === "timed" && timer.target > 0) {
      const elapsed = Math.max(0, timer.target - timer.milliseconds);
      $("wall-progress").style.width = Math.min(100, elapsed / timer.target * 100) + "%";
    } else {
      $("wall-progress").style.width = timer && timer.mode === "count_up" ? "100%" : "0%";
    }
  }
  function make(label, className, tag = "span") {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = label;
    return el;
  }
  function trackRow(track) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/5 px-5 py-4";
    const info = document.createElement("div");
    info.className = "min-w-0";
    info.appendChild(make(track.title, "truncate text-sm font-semibold text-white/90", "p"));
    const label = track.mode === "todo" ? "To-do" : track.mode === "count_up" ? "Count up" : "Timed";
    const done = track.state === "completed" || track.state === "finalized" || track.completed;
    info.appendChild(make(label + " · " + (track.state || (done ? "Completed" : "Scheduled")),
      "mt-1 text-xs text-white/45", "p"));
    row.appendChild(info);
    const button = document.createElement("button");
    const isActive = state.active?.trackId === track.id;
    const isTodo = track.mode === "todo";
    button.textContent = isTodo ? (done ? "Undo" : "Done") : isActive ? "Running" : done ? "Finished" : "Start";
    button.className = "shrink-0 rounded-xl border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40";
    button.disabled = pending || state.status !== "connected" || state.stale ||
      (!isTodo && (isActive || Boolean(state.active) || done));
    button.dataset.action = isTodo ? "todo" : "start";
    button.dataset.trackId = track.id;
    if (isTodo) button.dataset.completed = String(!done);
    row.appendChild(button);
    return row;
  }
  function draw() {
    drawClock();
    text("wall-status", statusLabel());
    text("connection", statusLabel());
    const ready = state.status === "connected" && !state.stale;
    $("pause").classList.toggle("hidden", !state.active);
    $("pause").disabled = pending || !ready;
    $("connect").classList.toggle("hidden", Boolean(state.active) || ready);
    $("connect").disabled = pending || state.status === "connecting";
    $("connect").textContent = state.status === "connecting" ? "Check your browser…" :
      state.status === "offline" ? "Reconnect / Retry" : "Connect Track account";
    $("disconnect").classList.toggle("hidden", state.status === "disconnected");
    text("today-label", state.date || "");
    const list = $("tracks");
    list.replaceChildren();
    const tracks = state.tracks || [];
    if (!tracks.length) {
      list.appendChild(make(ready ? "No Tracks scheduled for today." :
        "Connect your Track account to load today's schedule.",
        "rounded-2xl border border-white/10 bg-white/5 px-5 py-6 text-sm text-white/50", "p"));
    } else for (const track of tracks) list.appendChild(trackRow(track));
    const notice = actionError || state.error;
    $("notice").classList.toggle("hidden", !notice);
    text("notice", notice || "");
  }
  async function run(name, payload = {}) {
    if (pending) return;
    pending = true;
    actionError = null;
    draw();
    try {
      const result = await API.action(name, payload);
      if (!result?.ok) actionError = result?.error || "The operation was not completed.";
    } catch (err) {
      actionError = err.message || "The operation was not completed.";
    } finally {
      pending = false;
      draw();
    }
  }
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (["start", "pause", "todo", "connect", "disconnect", "refresh", "open-web"].includes(action)) {
      run(action, { trackId: target.dataset.trackId, completed: target.dataset.completed === "true" });
    }
  });
  API.onState((next) => { state = next; draw(); });
  if (mode === "wallpaper") API.onDesktopClick((pt) => {
    if (!pt) return;
    const node = document.elementFromPoint(pt.x, pt.y);
    if (node?.closest("[data-open-controls]")) API.action("controls").catch(() => {});
  });
  API.snapshot().then((snapshot) => { state = snapshot; draw(); }).catch((err) => {
    actionError = err.message;
    draw();
  });
  setInterval(drawClock, 250);
  draw();
})();
