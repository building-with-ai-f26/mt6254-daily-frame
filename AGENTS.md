# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** Daily Frame, a private photo journal: one photo and one honest reflection per day, kept on your own device. Each day's post also saves a snapshot of that day's weather.
- **Primary user & core workflow:** People who want to journal without performing for social media. Open the calendar, tap today, add a photo, write a reflection, and look back at the month. See the living PRD in `docs/index.html`.
- **Tech stack:** Plain HTML/CSS/JavaScript (no build step, no framework) · IndexedDB in the browser for entries and photos · Python 3 standard library server (`server.py`) · OpenWeatherMap Current Weather API · PostHog for analytics and session replay · hosted on Render (free web service, `render.yaml`). No AI model and no server database: the server stores nothing.

## 2. Commands
- **Install dependencies:** none. You only need Python 3 (preinstalled on macOS) and a browser.
- **Set up keys (once):** `cp .env.example .env`, then put your OpenWeatherMap key (https://home.openweathermap.org/api_keys) after `OPENWEATHER_API_KEY=`. The PostHog key is already filled in (it is public).
- **Run locally:** `python3 server.py`, then open http://localhost:8000. Stop with Ctrl+C.
- **Check the weather endpoint:** `curl "http://localhost:8000/api/weather?lat=40.73&lon=-74.00"`
- **Run deterministic tests:** none yet (Build 4).
- **Run model evals:** none (no AI model yet).

Use `server.py`, not `python3 -m http.server`: the plain file server cannot call OpenWeatherMap, so the weather chip will show an error.

## Project structure

| Path | What it is |
| --- | --- |
| `server.py` | Local server. Serves `app/`, answers `GET /api/weather` by calling OpenWeatherMap with the key from `.env`, and serves `GET /config.js` with the public PostHog settings. Logs each weather call with timing and cost. |
| `app/index.html` | The single page: calendar view, day view (with the 5-face mood picker; faces live in `app/img/mood-1..5.png`) and monthly recap view. |
| `app/app.js` | All app logic: IndexedDB storage, calendar, day view, photo resize and HEIC handling, reflection lock/edit, mood (`showMood`, `onMoodClick`), weather snapshot (`captureWeather`, `showWeather`), monthly recap (`openRecap`, `analyzeMonth`, `summaryText`) and animated collage (`buildCollage`), theme, analytics events. |
| `app/analytics.js` | PostHog setup for the app, plus `track(event, props)` used by `app.js`. Does nothing if no key is set. |
| `app/style.css` | Styles: cloud background, Day/Night themes (Mist accent). |
| `app/vendor/heic-to.js` | Vendored HEIC converter (loaded only for iPhone photos). |
| `docs/index.html` | Public Product Page (GitHub Pages): pitch, living PRD, build log. Has its own PostHog snippet. |
| `.env.example` | Template for `.env`. Real `.env` is git-ignored. |
| `render.yaml` | Render Blueprint for the live site: start command and environment variables (the weather key is entered in Render, never here). |
| `SECURITY.md` | Security audit: what was checked, found, fixed and still open. |

**Data flow for one post:** photo or reflection saved in IndexedDB → first save of today calls `/api/weather?lat&lon` (rounded to 2 decimals; falls back to `WEATHER_CITY`) → `server.py` calls `api.openweathermap.org/data/2.5/weather` → trimmed result `{tempC, feelsLikeC, description, icon, city, country, capturedAt}` saved as `entry.weather` → shown under the date. Only today gets a snapshot (the free plan has no history).

**Mood:** each day can store `entry.mood` (1 = rough … 5 = amazing). Tapping the selected face again clears it. A mood by itself is enough to keep a day's entry.

**Monthly recap:** built entirely in the browser from that month's IndexedDB entries. No AI and no network calls. The summary uses recurring words (counted by how many days they appear), one standout sentence per day, and mood counts and trend. The collage shows up to 9 photos in a 4-column mosaic that slowly drifts and swaps photos every ~3 s, and it starts paused when the device asks for reduced motion. URL: `#recap-YYYY-MM`.

## Privacy rules for this project
- Photos and reflection text never leave the device. Do not send them to any API or analytics event; send counts or flags only. The mood value counts as private too: analytics get `mood_set`/`mood_cleared` with no value.
- Anything that shows a photo or reflection gets the `ph-no-capture` class so PostHog replays block it. Location text gets `ph-mask`.
- Never put the OpenWeatherMap key in anything under `app/` or `docs/`.
- Every route that calls OpenWeatherMap goes through `rate_limited()` in `server.py` (10 calls per visitor per minute, 50 for everyone together). Keep it that way for any new API route.

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.

## 4. Shipping (deploy to the live site)
Live app: https://daily-frame.onrender.com (Render free web service, built from `render.yaml`). Product Page stays on GitHub Pages.

1. **Check locally first:** `python3 server.py`, open http://localhost:8000, add a photo to today, and confirm the weather chip appears.
2. **Key search before every push:** `git grep -nE 'sb_secret_|service_role|sk-or-|sk-ant-|sk-proj-|sk_live_'` must print nothing, and `git status` must not list `.env`.
3. **Commit and push to `main`, then deploy.** Render is connected by the repo's public URL (the class organization doesn't have Render's GitHub app), so it does not auto-deploy. In the Render dashboard → daily-frame → **Manual Deploy → Deploy latest commit**, then watch Events until it says "Deploy live".
4. **Verify the live site:** open the live URL on a phone, tap today, add a photo, write a reflection, see the weather. Then run `curl -sI https://daily-frame.onrender.com/ | grep -i x-content-type` (expects `nosniff`).
5. **Rate-limit check:** `for i in $(seq 30); do curl -s -o /dev/null -w '%{http_code} ' "https://daily-frame.onrender.com/api/weather?lat=40.73&lon=-74.00"; done` should switch to `429` after 10 calls.
6. **Roll back a bad deploy:** Render dashboard → daily-frame → Events → pick the last good deploy → "Rollback". Or `git revert <bad-commit>` and push.

First-time setup (done Nov 22): Render → Blueprints → New Blueprint Instance → public repo URL `https://github.com/building-with-ai-f26/mt6254-daily-frame`. The OpenWeatherMap key goes in Render → daily-frame → Environment → `OPENWEATHER_API_KEY` (the human pastes it; the agent never handles keys). The free plan sleeps after 15 minutes idle, so the first visit can take about a minute to wake up.

## 5. Ask me first
Stop and ask the human before any of these, even if a task seems to need it:
- **Deleting data or changing storage:** deleting files or branches, `git reset --hard`, force-pushing, rewriting history, changing the IndexedDB schema or the `entries` store (users would lose their journal), or clearing site data.
- **Keys, secrets and permissions:** creating, reading, printing, rotating or moving any key; editing `.env` or Render environment variables; changing GitHub, Render or PostHog settings or who has access.
- **Anything that costs money:** upgrading a Render or OpenWeatherMap plan, adding a paid API or AI model, raising the rate limits in `server.py`, or entering payment details.
- **Production:** changing `render.yaml`, the start command, or deploying anything other than a normal push to `main`.

## 6. Rules learned from real mistakes
- **Read the actual license before naming it.** In Build 1 the agent vendored `heic-to` and wrote "MIT" in the commit message, but `app/vendor/LICENSE` is LGPL-3.0. Before saying what license a dependency has, open its LICENSE file (or `npm view <pkg> license`) and quote what it says.
- **Commit work in progress.** In Build 2 an untracked experiment (Spotify/YouTube) was never committed, so the work left no record. Commit small steps on the day they happen, even when they don't work yet.
