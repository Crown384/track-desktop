"use strict";

const { randomUUID } = require("node:crypto");
const { BrowserWindow, session } = require("electron");
const { isAllowedAuthNavigation } = require("./oauth-navigation");

function openTrackAuthorization({ authorizationUrl, redirectUri, waitForCode, parent }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Use a fresh, memory-only cookie jar on every sign-in. Disconnecting
    // cannot accidentally reuse a previously authenticated web session.
    const partition = "track-desktop-sign-in-" + randomUUID();
    const options = {
      width: 640,
      height: 780,
      minWidth: 480,
      minHeight: 580,
      title: "Sign in to Track Desktop",
      backgroundColor: "#f8fafc",
      autoHideMenuBar: true,
      show: false,
      center: true,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: Boolean(parent && !parent.isDestroyed()),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: false,
        partition,
      },
    };
    const win = new BrowserWindow(options);
    const isolatedSession = session.fromPartition(partition);
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    function complete(error, code) {
      if (settled) return;
      settled = true;
      if (!win.isDestroyed()) win.close();
      if (error) reject(error);
      else resolve(code);
    }

    // The authorization form is served by the existing TrackOS website, but
    // it is displayed INSIDE the desktop app, never in Chrome/Edge.
    // No preload or Node API is exposed to this remote page.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const validateNavigation = (event, destination) => {
      if (!isAllowedAuthNavigation(destination, authorizationUrl, redirectUri)) {
        event.preventDefault();
      }
    };
    win.webContents.on("will-navigate", validateNavigation);
    win.webContents.on("will-redirect", validateNavigation);
    win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3 && !settled) complete(new Error(
        "Could not load Track sign-in (" + description + "). Please try again."
      ));
    });
    win.on("closed", () => {
      if (!settled) complete(new Error("Track sign-in was cancelled."));
    });
    win.once("ready-to-show", () => {
      if (!settled && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    // The existing local OAuth callback completes the authorization.
    // The sign-in window is closed automatically once the code arrives.
    Promise.resolve(waitForCode).then(
      (code) => complete(null, code),
      (error) => complete(error)
    );
    win.loadURL(authorizationUrl).catch((error) => complete(error));
  });
}
module.exports = { openTrackAuthorization };
