"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, safeStorage, shell } = require("electron");
const { normalizeTracks } = require("./logic");

const BASE = (process.env.TRACK_DESKTOP_ORIGIN || "https://track.pama.company").replace(/\/+$/, "");
const origin = new URL(BASE);
if (origin.protocol !== "https:" && !(
  origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)
)) throw new Error("Track server must use HTTPS (except local development)");

const secretPath = () => path.join(app.getPath("userData"), "track-credentials.bin");
const encode = (buffer) => buffer.toString("base64url");
const random = (n = 32) => encode(crypto.randomBytes(n));
const pkce = (verifier) => encode(crypto.createHash("sha256").update(verifier).digest());
const FETCH_TIMEOUT = 15000;

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT), redirect: "error" });
  return response;
}
async function jsonOrError(response) {
  if (!response.ok) throw new Error("Track server returned HTTP " + response.status);
  return response.json();
}
function getStored() {
  if (!fs.existsSync(secretPath())) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encrypted credential storage is unavailable");
  try {
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(secretPath())));
  } catch {
    throw new Error("Saved Track credentials could not be decrypted. Disconnect and reconnect.");
  }
}
function saveStored(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encrypted credential storage is unavailable");
  const bytes = safeStorage.encryptString(JSON.stringify(value));
  const target = secretPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + ".tmp", bytes, { mode: 0o600 });
  fs.renameSync(target + ".tmp", target);
}
function removeStored() {
  try { fs.unlinkSync(secretPath()); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Only a loopback, one-shot, state-validated OAuth callback is accepted.
function callbackListener() {
  return new Promise((resolve, reject) => {
    const state = random();
    let finished = false;
    let server;
    let timeout;
    let rejectCallback;
    const result = new Promise((done, fail) => {
      rejectCallback = fail;
      server = http.createServer((req, res) => {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        const good = req.method === "GET" && u.pathname === "/callback" && u.searchParams.get("state") === state;
        res.writeHead(good ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(good ? "<!doctype html><title>Return to Track Desktop</title><p>Return to Track Desktop to finish connecting.</p>" :
          "<!doctype html><title>Invalid callback</title><p>Invalid connection response.</p>");
        if (!good || finished) return;
        finished = true;
        clearTimeout(timeout);
        server.close();
        if (u.searchParams.has("error")) fail(new Error("Track authorization was declined"));
        else if (!u.searchParams.get("code")) fail(new Error("Missing Track authorization code"));
        else done(u.searchParams.get("code"));
      });
      server.on("error", fail);
    });
    server.listen(0, "127.0.0.1", () => {
      timeout = setTimeout(() => {
        server.close();
        rejectCallback(new Error("Track sign-in timed out"));
      }, 3 * 60 * 1000);
      const redirectUri = "http://127.0.0.1:" + server.address().port + "/callback";
      resolve({
        redirectUri,
        state,
        wait: result.finally(() => { clearTimeout(timeout); server.close(); }),
        cancel: () => { clearTimeout(timeout); server.close(); },
      });
    });
  });
}

class TrackClient {
  constructor(onChange) {
    this.onChange = onChange;
    this.credentials = null;
    this.state = { status: "disconnected", stale: false, active: null, tracks: [], date: null, error: null, updatedAt: null };
    this.sessionId = null;
    this.sequence = 0;
    this.initialized = false;
    this.refreshPromise = null;
    this.pollPromise = null;
    this.timer = null;
    this.lastTracksAt = 0;
    this.epoch = 0;
  }
  emit(patch) {
    Object.assign(this.state, patch);
    this.onChange({ ...this.state });
  }
  async start() {
    try {
      this.credentials = getStored();
      if (this.credentials) {
        this.emit({ status: "connecting", error: null });
        await this.sync(true);
      } else this.emit({ status: "disconnected" });
    } catch (err) {
      this.emit({ status: "disconnected", error: err.message });
    }
    this.timer = setInterval(() => { if (this.credentials) this.sync(false).catch(() => {}); }, 20000);
  }
  async connect() {
    if (this.credentials) return this.sync(true);
    const verifier = random(48);
    const epoch = ++this.epoch;
    const callback = await callbackListener();
    this.emit({ status: "connecting", error: null });
    try {
      const registration = await jsonOrError(await request(BASE + "/api/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Track Desktop",
          redirect_uris: [callback.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
        }),
      }));
      if (!registration.client_id) throw new Error("Track did not register this desktop client");
      const url = new URL(BASE + "/oauth/authorize");
      Object.entries({
        response_type: "code", client_id: registration.client_id,
        redirect_uri: callback.redirectUri, code_challenge: pkce(verifier),
        code_challenge_method: "S256", state: callback.state,
        resource: BASE, scope: "track.read track.write offline_access",
      }).forEach(([key, value]) => url.searchParams.set(key, value));
      await shell.openExternal(url.toString());
      const code = await callback.wait;
      const form = new URLSearchParams({
        grant_type: "authorization_code", code, client_id: registration.client_id,
        redirect_uri: callback.redirectUri, code_verifier: verifier, resource: BASE,
      });
      const token = await jsonOrError(await request(BASE + "/api/oauth/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
      }));
      if (!token.access_token || !token.refresh_token) throw new Error("Track returned invalid credentials");
      if (epoch !== this.epoch) throw new Error("Track connection was cancelled");
      this.credentials = {
        clientId: registration.client_id, accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
      };
      saveStored(this.credentials);
      this.initialized = false;
      return await this.sync(true);
    } catch (error) {
      this.emit({ status: "disconnected", error: error.message });
      throw error;
    } finally {
      callback.cancel();
    }
  }
  async disconnect() {
    this.epoch += 1;
    this.credentials = null;
    this.sessionId = null;
    this.initialized = false;
    removeStored();
    this.emit({ status: "disconnected", stale: false, active: null, tracks: [], date: null, updatedAt: null, error: null });
  }
  async token() {
    if (!this.credentials) throw new Error("Connect to Track first");
    if (this.credentials.expiresAt > Date.now() + 60000) return this.credentials.accessToken;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const current = this.credentials;
      const form = new URLSearchParams({
        grant_type: "refresh_token", client_id: current.clientId,
        refresh_token: current.refreshToken, resource: BASE,
      });
      const t = await jsonOrError(await request(BASE + "/api/oauth/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form,
      }));
      if (!t.access_token || !t.refresh_token) throw new Error("Track session expired. Reconnect your account.");
      if (this.credentials !== current) throw new Error("Track session was disconnected");
      this.credentials = {
        ...this.credentials, accessToken: t.access_token,
        refreshToken: t.refresh_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
      };
      saveStored(this.credentials);
      return this.credentials.accessToken;
    })();
    try { return await this.refreshPromise; }
    finally { this.refreshPromise = null; }
  }
  async rpc(method, params, isNotification = false) {
    const token = await this.token();
    const id = ++this.sequence;
    const payload = { jsonrpc: "2.0", method };
    if (!isNotification) payload.id = id;
    if (params !== undefined) payload.params = params;
    const headers = {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await request(BASE + "/mcp", {
      method: "POST", headers, body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("Track MCP request failed (" + response.status + ")");
    const sid = response.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (isNotification || response.status === 202 || response.status === 204) return null;
    const body = await response.text();
    let messages;
    if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
      messages = body.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } }).filter(Boolean);
    } else {
      try { messages = [JSON.parse(body)]; } catch { throw new Error("Track MCP returned an invalid response"); }
    }
    const result = messages.find((message) => message.id === id);
    if (!result) throw new Error("Track MCP did not return a response");
    if (result.error) throw new Error(result.error.message || "Track MCP failed");
    return result.result;
  }
  async ensureSession() {
    if (this.initialized) return;
    this.sessionId = null;
    const info = await this.rpc("initialize", {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "track-desktop", version: "0.1.0" },
    });
    if (!info?.protocolVersion) throw new Error("Track MCP initialization failed");
    await this.rpc("notifications/initialized", undefined, true);
    this.initialized = true;
  }
  async callTool(name, args = {}) {
    await this.ensureSession();
    const reply = await this.rpc("tools/call", { name, arguments: args });
    if (reply?.isError) throw new Error(reply.content?.find((x) => x.type === "text")?.text || "Track action failed");
    return reply?.structuredContent || {};
  }
  async sync(force = false) {
    if (!this.credentials) return;
    if (this.pollPromise) return this.pollPromise;
    const epoch = this.epoch;
    this.pollPromise = (async () => {
      try {
        const activeData = await this.callTool("get_active_track");
        const next = { active: activeData.active_track || null, stale: false, error: null, status: "connected", updatedAt: Date.now() };
        if (force || Date.now() - this.lastTracksAt > 60000) {
          const todayData = await this.callTool("get_todays_tracks");
          next.tracks = normalizeTracks(todayData.tracks);
          next.date = todayData.date || null;
          this.lastTracksAt = Date.now();
        }
        if (epoch === this.epoch) this.emit(next);
      } catch (error) {
        if (epoch === this.epoch) {
          this.initialized = false;
          this.emit({ status: "offline", stale: true, error: error.message });
        }
      }
    })();
    try { await this.pollPromise; } finally { this.pollPromise = null; }
  }
  async command(action, trackId, completed) {
    if (!this.credentials || this.state.status !== "connected" || this.state.stale) throw new Error("Reconnect before changing a Track");
    if (action === "start") {
      if (typeof trackId !== "string" || !this.state.tracks.some((t) => t.id === trackId && t.mode !== "todo")) {
        throw new Error("Select an eligible Track from today's list");
      }
      await this.callTool("start_track", { track_id: trackId });
    } else if (action === "pause") {
      if (!this.state.active) throw new Error("No active Track to pause");
      await this.callTool("pause_active_track");
    } else if (action === "todo") {
      if (typeof trackId !== "string" || !this.state.tracks.some((t) => t.id === trackId && t.mode === "todo")) {
        throw new Error("Select a To-do from today's list");
      }
      await this.callTool("set_todo_completed", { track_id: trackId, completed: completed === true });
    } else throw new Error("Unsupported Track action");
    await this.sync(true);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { TrackClient };
