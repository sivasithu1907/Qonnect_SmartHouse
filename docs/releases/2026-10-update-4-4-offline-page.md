# Update 4.4: no more blank page when the server can't be reached

**Problem.** When the browser couldn't reach Qonnect (for example, the staging SSH tunnel was closed, or the app was restarting), the service worker showed an old cached copy of the page. That copy pointed to build files that weren't cached, so the result was a white page with failed requests in DevTools.

**Fix:**
- Page loads always come from the server. If the server doesn't answer, Qonnect shows a small **"Can't reach Qonnect"** page. A **Try again** button reloads the same section once the connection is back.
- An icon or manifest that isn't cached now fails as a normal network error instead of an empty response.
- Caching rules are unchanged: only static app files are cached, and nothing from `/api`.

**After deploying:** browsers that already have the old service worker pick up the new one the next time they load Qonnect while connected. If a browser still shows a blank page, open DevTools → Application → Storage → **Clear site data**, then reload.

Changed: `public/sw.js`, `src/main.tsx` (removes the `?retry=` marker after reloading). New: `tests/service-worker.test.ts`, this file. No migration.
