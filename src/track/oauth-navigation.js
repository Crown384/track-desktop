"use strict";

// A desktop sign-in view is only allowed to navigate within Track's own
// authorization origin, or to the exact one-shot loopback OAuth callback.
// Never load arbitrary external pages in Electron's sign-in window.
function isAllowedAuthNavigation(destination, authorizationUrl, redirectUri) {
  try {
    const url = new URL(destination);
    const authorization = new URL(authorizationUrl);
    const callback = new URL(redirectUri);
    const isTrackPage = url.origin === authorization.origin &&
      url.protocol === authorization.protocol &&
      (url.protocol === "https:" || (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ));
    const isExpectedCallback = url.origin === callback.origin &&
      url.pathname === callback.pathname &&
      url.searchParams.get("state") === authorization.searchParams.get("state") &&
      Boolean(url.searchParams.get("state")) &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1";
    return isTrackPage || isExpectedCallback;
  } catch {
    return false;
  }
}
module.exports = { isAllowedAuthNavigation };
