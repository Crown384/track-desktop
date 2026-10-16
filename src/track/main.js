"use strict";
const path = require("node:path");
const { app, BrowserWindow, ipcMain, Menu, Tray, screen, shell, nativeImage, dialog } = require("electron");
const desktopHost = require("../main/desktop-host");
const desktopInput = require("../main/desktop-input");
const config = require("../main/config");
const { TrackClient } = require("./track-client");
const { openTrackAuthorization } = require("./oauth-window");

const ROOT = path.join(__dirname, "../..");
const HTML = path.join(__dirname, "index.html");
const PRELOAD = path.join(__dirname, "preload.js");
const ICON = path.join(ROOT, "build", "icon.png");
const TRAY_ICON = path.join(ROOT, "build", "tray.png");
const TRACK_SITE = "https://track.pama.company";
let wallpaper = null;
let controls = null;
let tray = null;
let watchdog = null;
let quitting = false;
let working = false;
let attachedProgman = null;
let rebuilding = null;
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();
app.on("second-instance", () => openControls());

const client = new TrackClient((state) => {
  for (const win of [wallpaper, controls]) {
    if (win && !win.isDestroyed()) win.webContents.send("track:state", state);
  }
  if (tray && !tray.isDestroyed()) tray.setToolTip(
    state.active ? "Track · " + (state.active.trackTitle || "Focus") : "Track Desktop"
  );
  refreshMenu();
}, (authorizationUrl, redirectUri, waitForCode) => {
  openControls();
  return openTrackAuthorization({
    authorizationUrl,
    redirectUri,
    waitForCode,
    parent: controls,
  });
});
function restrictNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
function makeWindow(bounds, mode) {
  const desktop = mode === "wallpaper";
  const win = new BrowserWindow({
    ...bounds, title: desktop ? "Track Wallpaper" : "Track Controls",
    show: false, frame: !desktop, thickFrame: !desktop,
    resizable: !desktop, focusable: !desktop, skipTaskbar: desktop,
    hasShadow: !desktop, backgroundColor: "#0a0b10", icon: ICON,
    webPreferences: {
      preload: PRELOAD, nodeIntegration: false,
      contextIsolation: true, sandbox: false,
      backgroundThrottling: false,
    },
  });
  if (desktop) win.setIgnoreMouseEvents(true);
  restrictNavigation(win);
  win.loadFile(HTML, { query: { mode } });
  return win;
}
function pagePoint(pt) {
  const p = screen.screenToDipPoint(pt);
  const b = screen.getPrimaryDisplay().bounds;
  return { x: p.x - b.x, y: p.y - b.y };
}
function createWallpaper() {
  if (wallpaper || config.get("paused") || quitting) return;
  const display = screen.getPrimaryDisplay();
  const win = makeWindow(display.bounds, "wallpaper");
  wallpaper = win;
  win.once("ready-to-show", () => {
    if (quitting || win.isDestroyed()) return;
    const rect = screen.dipToScreenRect(null, display.bounds);
    try {
      const attached = desktopHost.attach(win, rect);
      if (!attached) throw new Error("Windows Explorer did not accept desktop attachment");
      attachedProgman = desktopHost.currentProgman();
      win.showInactive();
      desktopInput.start(win, {
        onClick: (pt) => win.webContents.send("track:desktop-click", pagePoint(pt)),
        onHover: () => {},
      });
    } catch (error) {
      desktopInput.stop();
      wallpaper = null;
      win.destroy();
      dialog.showErrorBox("Track wallpaper unavailable",
        "Windows desktop attachment failed. Track controls remain accessible in the system tray.\n" + error.message);
    }
  });
  win.on("closed", () => {
    if (wallpaper === win) {
      wallpaper = null;
      desktopInput.stop();
      if (!quitting && !config.get("paused")) setTimeout(createWallpaper, 1500);
    }
  });
}
function removeWallpaper() {
  desktopInput.stop();
  if (!wallpaper) return;
  const win = wallpaper;
  wallpaper = null;
  win.removeAllListeners("closed");
  if (!win.isDestroyed()) win.destroy();
  desktopHost.restoreSystemWallpaper();
}
function reopenWallpaper() {
  if (rebuilding) clearTimeout(rebuilding);
  rebuilding = setTimeout(() => {
    rebuilding = null;
    removeWallpaper();
    createWallpaper();
  }, 700);
}
function openControls() {
  if (controls && !controls.isDestroyed()) {
    if (controls.isMinimized()) controls.restore();
    controls.show();
    controls.focus();
    return;
  }
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.min(780, work.width);
  const height = Math.min(780, work.height);
  controls = makeWindow({
    width, height,
    x: work.x + Math.round((work.width - width) / 2),
    y: work.y + Math.round((work.height - height) / 2),
  }, "controls");
  controls.once("ready-to-show", () => { if (controls && !controls.isDestroyed()) controls.show(); });
  controls.on("closed", () => { controls = null; });
}
function refreshMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Track controls", click: openControls },
    { label: "Open Track on the web", click: () => shell.openExternal(TRACK_SITE) },
    { type: "separator" },
    { label: client.state.status === "connected" ? "Connected to Track" : "Connect Track account",
      enabled: client.state.status !== "connected",
      click: () => { openControls(); client.connect().catch(() => {}); } },
    { label: "Refresh Tracks", click: () => client.sync(true).catch(() => {}) },
    { type: "separator" },
    { label: "Pause desktop wallpaper", type: "checkbox", checked: config.get("paused"),
      click: (item) => {
        config.set("paused", item.checked);
        if (item.checked) removeWallpaper();
        else createWallpaper();
      } },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { label: "Disconnect account", enabled: Boolean(client.credentials),
      click: () => client.disconnect().catch(() => {}) },
    { type: "separator" },
    { label: "Quit Track Desktop", click: () => app.quit() },
  ]));
}
function registerActions() {
  ipcMain.handle("track:snapshot", () => ({ ...client.state }));
  ipcMain.handle("track:action", async (_event, { name, payload } = {}) => {
    try {
      if (name === "controls") { openControls(); return { ok: true }; }
      if (name === "open-web") { await shell.openExternal(TRACK_SITE); return { ok: true }; }
      if (name === "refresh") { await client.sync(true); return { ok: true }; }
      if (name === "connect") { await client.connect(); return { ok: true }; }
      if (name === "disconnect") { await client.disconnect(); return { ok: true }; }
      if (["start", "pause", "todo"].includes(name)) {
        if (working) throw new Error("Another Track action is still processing");
        working = true;
        try { await client.command(name, payload?.trackId, payload?.completed); }
        finally { working = false; }
        return { ok: true };
      }
      throw new Error("Unsupported action");
    } catch (error) {
      return { ok: false, error: error.message || "Track operation failed" };
    }
  });
}
if (isPrimary) app.whenReady().then(async () => {
  if (process.platform !== "win32") {
    dialog.showErrorBox("Windows required", "Track Desktop wallpaper requires Windows 10 or 11.");
    app.quit();
    return;
  }
  registerActions();
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip("Track Desktop");
  tray.on("double-click", openControls);
  refreshMenu();
  createWallpaper();
  watchdog = setInterval(() => {
    if (!wallpaper || config.get("paused")) return;
    const current = desktopHost.currentProgman();
    if (current && current !== attachedProgman) reopenWallpaper();
  }, 5000);
  screen.on("display-metrics-changed", reopenWallpaper);
  screen.on("display-added", reopenWallpaper);
  screen.on("display-removed", reopenWallpaper);
  await client.start();
}).catch((err) => {
  dialog.showErrorBox("Track could not start", err.message);
  app.quit();
});
app.on("before-quit", () => {
  quitting = true;
  client.stop();
  if (watchdog) clearInterval(watchdog);
  if (rebuilding) clearTimeout(rebuilding);
  removeWallpaper();
});
