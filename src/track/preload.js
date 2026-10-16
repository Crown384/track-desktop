"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("trackDesktop", {
  snapshot: () => ipcRenderer.invoke("track:snapshot"),
  action: (name, payload) => ipcRenderer.invoke("track:action", { name, payload }),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("track:state", handler);
    return () => ipcRenderer.removeListener("track:state", handler);
  },
  onDesktopClick: (callback) => {
    const handler = (_event, point) => callback(point);
    ipcRenderer.on("track:desktop-click", handler);
    return () => ipcRenderer.removeListener("track:desktop-click", handler);
  },
});
