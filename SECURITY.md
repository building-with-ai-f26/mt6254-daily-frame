# Security Audit: Daily Frame (Build 3)

**Date:** November 22–23, 2026 · **Lane:** Beginner · **Live app:** https://daily-frame.onrender.com

## What kind of app this is

**No AI and no database.** Photos, reflections and moods are saved in each visitor's own browser (IndexedDB). The server (`server.py`, Python standard library only) stores nothing: it serves the static files in `app/`, serves `/config.js` with the public PostHog settings, and proxies one route, `GET /api/weather`, to OpenWeatherMap using a key that lives only in Render's environment variables (and in `.env` locally).

There is no sign-in and no server database, so there is no Account A / Account B data to cross and no table that needs Row Level Security. The assignment's test for this kind of app is the secret key search. Because the weather route does use a key, I also added and tested a rate limit on it.

## Main test: secret key search

| Where | How | Result |
| --- | --- | --- |
| Repo, current files | `git grep -nE 'sb_secret_\|service_role\|sk-or-\|sk-ant-\|sk-proj-\|sk_live_'` | Only the placeholder `sk-or-v1-replace-with-your-key` in `.env.example`. Clean. |
| Repo, all 30+ commits | Same search over `git rev-list --all`, plus a search for any 32-character hex string (the shape of an OpenWeatherMap key) | Nothing found. `.env` was never committed. |
| Live site (Nov 22, 9:18 PM) | Searched every file the browser loads (`/`, `/app.js`, `/analytics.js`, `/style.css`, `/config.js`) for the same patterns and for the OpenWeatherMap key | Only the PostHog `phc_` key, which is public by design. Clean. |
| Product Page (GitHub Pages) | Same search on `docs/index.html` | Only the PostHog `phc_` key. Clean. |

No key needed rotating.

## What I checked

1. **Access controls:** no accounts or shared data on the server, so nothing to cross. Each visitor's journal lives only in their own browser.
2. **Secret keys on the server:** the OpenWeatherMap key is read from the environment in `server.py` and never sent to the browser. `/config.js` only contains the PostHog key and host.
3. **File storage:** none on the server. Photos never leave the device. (No storage buckets.)
4. **Protecting production from the agent:** added an "Ask me first" list to `AGENTS.md` (deleting data, keys and permissions, anything that costs money, production changes). There is no server database to back up; each visitor's data is in their own browser.
5. **Spending caps and rate limits:** see below.
6. **Dependencies:** `pip-audit` (no third-party Python packages; the server uses only the standard library) found no known vulnerabilities. The one JavaScript dependency is the vendored `heic-to` converter: `npm audit` on `heic-to` (latest 1.6.7) found 0 vulnerabilities.
7. **Agent security review:** asked the coding agent to look for vulnerabilities and try to break the server. Results in the next section.

## What the agent tried, what it found, and what I fixed

| Attack or check | Before | After |
| --- | --- | --- |
| Call `/api/weather` 30 times in a row | Every call went to OpenWeatherMap. A script could burn the free plan's 60/min limit and break weather for everyone. | **Fixed.** Per-visitor limit of 10 calls a minute plus 50 a minute for all visitors together. Calls past the limit return **429** with `Retry-After`, and the app shows "Too many weather requests. Try again in a minute." On the live site (Nov 22, 9:18 PM): calls 1–9 returned 503 (no weather key on Render yet; one earlier test call used up the 10th slot) and calls 10–30 returned 429. |
| Send `lat=nan` or `lat=999` | Passed straight to OpenWeatherMap. | **Fixed.** Returns 400 unless lat is -90..90 and lon is -180..180. |
| Open `/vendor/` | Python's file server showed a folder listing. | **Fixed.** Folder listings return 404. |
| Path traversal (`/../.env`, `/../server.py`) | Blocked by Python's file server, which only serves `app/`. | No change needed; still 404. |
| `POST`, `PUT`, `DELETE` to any route | Return 501 (not supported). | No change needed. |
| Load the app inside someone else's page (clickjacking) | Allowed. | **Fixed.** `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`. |
| Missing security headers | None sent. | **Fixed.** Every response now sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` (location only for this site; no camera or mic), HSTS on Render, and a Content Security Policy. |
| Cross-site scripting through a reflection | Reflection text is shown with `textContent`, never `innerHTML`, so typed HTML stays plain text. | No change needed. |
| Server would not be reachable on Render | `server.py` only listened on 127.0.0.1. | **Fixed.** Listens on 0.0.0.0 when Render's `RENDER` variable is set; still 127.0.0.1 on my laptop. |
| Session replay leaking private content | Photos, reflections, recap and collage have `ph-no-capture`; the weather location has `ph-mask`; inputs are masked. | No change needed. Live events are now tagged `surface: live_app` so they're separate from local testing. |

## Spending caps

- **OpenWeatherMap:** free plan with no card on file, so it cannot charge me. The rate limit keeps usage under the free 60 calls/minute.
- **Render:** free web service, no paid add-ons.
- **PostHog:** free plan (1M events, 5,000 replays a month).
- **AI provider:** the app has no AI model. My OpenRouter key is not used by this app and is not on the server. Before adding any AI feature, set a hard monthly credit limit on that key in OpenRouter.

## Remaining issues

- **Weather key on Render:** the live service was created without `OPENWEATHER_API_KEY`, so until it's pasted in (Render → daily-frame → Environment), the weather chip says "No weather key set" and the rest of the app works normally. The key is entered only in Render, never in the repo.
- **Rate limit can be dodged by faking the visitor address.** The per-visitor limit trusts the first address in `X-Forwarded-For`, which a caller can set. The 50-a-minute limit for everyone together still protects the key, but one person could use up that shared limit for a minute.
- **Rate limit resets when the server restarts** (it lives in memory, and Render's free plan restarts the server after it sleeps). Fine at this size.
- **The strict Content Security Policy is report-only for now.** It's sent as `Content-Security-Policy-Report-Only` so it can't break PostHog or the HEIC converter. Next step: check the live site's console for reports, then switch it to enforced.
- **The vendored `heic-to` file has no version number in it,** so I can't prove it's 1.6.7. Next step: re-vendor 1.6.7 from npm.
- **Free Render plan sleeps after 15 minutes idle,** so the first visit can take about a minute. Not a security issue, but it affects testing.
- **Journal data lives in one browser.** If someone clears their browser data, their journal is gone, and there's no backup or sync yet. That's a privacy choice, but it's also a data-loss risk.
