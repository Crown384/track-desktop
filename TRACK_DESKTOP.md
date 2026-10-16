# Track Desktop — Windows launcher

This branch turns the Live Wallpaper Dashboard fork into an authenticated TrackOS desktop companion. The existing Windows Explorer integration is reused; the original source remains under src/main and src/renderer for reference. The new app entry is src/track/main.js.

## What is implemented

- Electron wallpaper behind desktop icons using the fork's WorkerW / Progman Win32 integration; ordinary desktop icons and clicks remain managed by Explorer.
- Click the countdown on empty desktop space or use the tray menu to open normal Track controls.
- In-app email verification: click Connect Track account to open a dedicated Track Desktop sign-in modal. Enter email, receive the existing Mailjet code, type the code inside the app, then approve access. The sign-in UI reuses TrackOS's hosted OAuth page in an isolated, sandboxed Electron window; it does **not** open Chrome/Edge. OAuth 2.1 public-client sign-in still uses /api/oauth/register, /oauth/authorize and /api/oauth/token with a one-shot loopback callback, S256 PKCE and CSRF state.
- Store refresh/access tokens only in Electron safeStorage-encrypted user data (never renderer IPC or localStorage). Request read/write OAuth scopes and offline_access.
- Connect to existing /mcp server using streamable HTTP and its existing get_active_track, get_todays_tracks, start_track, pause_active_track, and set_todo_completed tools.
- Show active countdown / count-up from the server's resumedAt and accumulated milliseconds; refresh authoritative data, preserve previous snapshot but disable all writes when offline.
- Start, pause and mark To-dos from the control window. All writes are validated by existing TrackOS backend. The desktop never marks a timed Track completed locally, changes Sin Hours, or creates an independent timer ledger.
- Simple Tailwind v4 utility-class interface with wallpaper mode, a control window, tray menu, wallpaper pause, and Start with Windows opt-in.

## Development

Windows 10 or 11, x64. Node 20+.

1. Run npm install.
2. Run npm test.
3. Run npm start. The prestart script compiles Tailwind.
4. Run npm run dist to create the NSIS installer (predist compiles the styles).

Optional for a local TrackOS backend only: TRACK_DESKTOP_ORIGIN=http://127.0.0.1:3000. Production uses https://track.pama.company by default. Never point the production app at an unknown OAuth server; only HTTPS origins are accepted away from loopback.

Credentials are automatically isolated per machine. They are never committed and are removed using Disconnect. Sign-in requires Electron's encrypted credential storage on Windows. A server outage does not trigger local-only timer mutations.

## Invariants and boundaries

- This first iteration uses TrackOS MCP as the remote, authoritative source and **is not yet an offline-first standalone desktop client**. Reading the last known data while offline is display-only until proper local-first sync is integrated; when offline, the UI disables mutation actions. The timer animation while disconnected is an extrapolation of the last server snapshot and is explicitly labeled stale.
- Today is determined by the **server-side account timezone** and get_todays_tracks result. Do not use the host PC date to decide what may start.
- Never calculate or submit a manual Track completion when the count reaches zero. Overtime and deadline/daily-reset boundaries are TrackOS responsibilities.
- Only one active timed/count-up Track: start_track refuses switches if another Track is active.
- TrackOS still hosts the secure sign-in form: the desktop presents that page within its sandboxed window instead of rebuilding email-code verification. A production UX pass may eventually provide a dedicated desktop-themed authorization page.
- The original wallpaper customizer, calendar, alarms and third-party wallpaper search are not surfaced in this Track-specific entry point. They are deliberately out of scope rather than duplicated.
- Upstream GitHub Releases auto-update is not enabled or configured for this fork, and original upstream release scripts were removed from package.json. The inherited release workflow must be disabled or rebuilt for this fork before a public release. Do not publish under the original author's app ID / releases.
- The existing upstream icon assets are temporary placeholders. Replace with licensed Track brand assets before public distribution.

## Mandatory QA before merge

- Fresh npm install **and regenerate/commit package-lock.json** after adding Tailwind dependencies; test on a clean Windows runner, not only a developer machine.
- Run npm test, npm run build:styles, npm run dist; launch installer on Windows 10 and 11 (including 24H2+), verify desktop icon click/drag/right-click, Explorer restart, DPI scaling, multiple-monitor and taskbar interactions.
- Complete **in-app** email send/code entry, consent, OAuth loopback PKCE, refresh-token rotation, revoked token, timeout/cancel, and reconnect tests against staging TrackOS server. Verify the entire login occurs in Track Desktop, external navigation is blocked, and the modal closes after successful authorization.
- Verify live sync and cross-device start/pause/start-resume with web/mobile, timezone reset, count-up/overtime, To-do completion and server-reconciled boundaries.
- Inspect the installed binary and test auto-start/pause and uninstall wallpaper restoration. Keep this PR draft until provider/browser and Windows QA are complete.

## Source attribution

Based on Rabiya Tahir's Live Wallpaper Dashboard (MIT): https://github.com/rabiya43/custom-wallpaper. Preserve the upstream MIT license and attribution.
