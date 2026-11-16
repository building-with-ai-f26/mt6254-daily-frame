# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** Daily Frame, a private photo journal: one photo and one honest reflection per day, kept on your own device. Each day's post also saves a snapshot of that day's weather.
- **Primary user & core workflow:** People who want to journal without performing for social media. Open the calendar, tap today, add a photo, write a reflection, and look back at the month. See the living PRD in `docs/index.html`.
- **Tech stack:** Plain HTML/CSS/JavaScript (no build step, no framework) · IndexedDB in the browser for entries and photos · Python 3 standard library server (`server.py`) · OpenWeatherMap Current Weather API · PostHog for analytics and session replay. No AI model yet.

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
| `app/index.html` | The single page: calendar view and day view. |
| `app/app.js` | All app logic: IndexedDB storage, calendar, day view, photo resize and HEIC handling, reflection lock/edit, weather snapshot (`captureWeather`, `showWeather`), theme, analytics events. |
| `app/analytics.js` | PostHog setup for the app, plus `track(event, props)` used by `app.js`. Does nothing if no key is set. |
| `app/style.css` | Styles, light/dark modes, accent colors. |
| `app/vendor/heic-to.js` | Vendored HEIC converter (loaded only for iPhone photos). |
| `docs/index.html` | Public Product Page (GitHub Pages): pitch, living PRD, build log. Has its own PostHog snippet. |
| `.env.example` | Template for `.env`. Real `.env` is git-ignored. |

**Data flow for one post:** photo or reflection saved in IndexedDB → first save of today calls `/api/weather?lat&lon` (rounded to 2 decimals; falls back to `WEATHER_CITY`) → `server.py` calls `api.openweathermap.org/data/2.5/weather` → trimmed result `{tempC, feelsLikeC, description, icon, city, country, capturedAt}` saved as `entry.weather` → shown under the date. Only today gets a snapshot (the free plan has no history).

## Privacy rules for this project
- Photos and reflection text never leave the device. Do not send them to any API or analytics event; send counts or flags only.
- Anything that shows a photo or reflection gets the `ph-no-capture` class so PostHog replays block it. Location text gets `ph-mask`.
- Never put the OpenWeatherMap key in anything under `app/` or `docs/`.

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
