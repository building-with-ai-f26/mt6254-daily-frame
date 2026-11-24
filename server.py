"""Daily Frame local server.

Serves the app in ./app and adds two small endpoints:
  GET /api/weather?lat=..&lon=..   current weather from OpenWeatherMap (key stays here, never in the browser)
  GET /config.js                   public PostHog settings for the browser

Run:  python3 server.py      then open http://localhost:8000
Only uses the Python standard library, so there is nothing to install.

The same file runs the live site on Render (see render.yaml): there it listens on 0.0.0.0
and reads its keys from Render's environment variables instead of .env.
"""

import json
import math
import os
import threading
import time
from collections import defaultdict, deque
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"


def load_env(path):
    """Read KEY=value lines from .env into os.environ (values already set in the shell win)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def real(value):
    """Treat the placeholder values from .env.example as missing."""
    return "" if "replace" in value else value


load_env(ROOT / ".env")
OWM_KEY = real(os.environ.get("OPENWEATHER_API_KEY", ""))
DEFAULT_CITY = os.environ.get("WEATHER_CITY", "New York,US")
POSTHOG_KEY = real(os.environ.get("POSTHOG_KEY", ""))
POSTHOG_HOST = os.environ.get("POSTHOG_HOST", "https://us.i.posthog.com")
PORT = int(os.environ.get("PORT", "8000"))
ON_RENDER = bool(os.environ.get("RENDER"))  # Render sets RENDER=true on every service
# Locally only this computer can reach the server; on Render the host must accept outside traffic.
HOST = os.environ.get("HOST", "0.0.0.0" if ON_RENDER else "127.0.0.1")
OWM_URL = "https://api.openweathermap.org/data/2.5/weather"

calls_today = {"date": time.strftime("%Y-%m-%d"), "count": 0}

# ---------- rate limits for /api/weather ----------
# The app needs one weather call per day per person, so these limits are generous for real use
# but stop a script from burning through the OpenWeatherMap key (free plan: 60 calls/minute).
PER_VISITOR_PER_MIN = int(os.environ.get("WEATHER_LIMIT_PER_VISITOR", "10"))
ALL_VISITORS_PER_MIN = int(os.environ.get("WEATHER_LIMIT_TOTAL", "50"))  # stays under the 60/min key limit
_hits = defaultdict(deque)   # visitor -> timestamps of recent calls
_all_hits = deque()          # timestamps of recent calls from everyone
_lock = threading.Lock()


def rate_limited(visitor):
    """Return seconds to wait if this visitor (or everyone together) is over the limit, else 0."""
    now = time.time()
    with _lock:
        for q in (_hits[visitor], _all_hits):
            while q and now - q[0] > 60:
                q.popleft()
        mine = _hits[visitor]
        if len(mine) >= PER_VISITOR_PER_MIN:
            return int(60 - (now - mine[0])) + 1
        if len(_all_hits) >= ALL_VISITORS_PER_MIN:
            return int(60 - (now - _all_hits[0])) + 1
        mine.append(now)
        _all_hits.append(now)
        if len(_hits) > 5000:  # forget idle visitors so memory stays small
            for k in [k for k, q in _hits.items() if not q]:
                del _hits[k]
        return 0


# Sent with every response. The enforced policy blocks framing and plugins; the Report-Only
# policy is the stricter target: the browser console reports what it would block, nothing breaks.
CSP_ENFORCED = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
CSP_REPORT_ONLY = (
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://us-assets.i.posthog.com; "
    "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com; "
    "img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; "
    "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
)


def fetch_weather(params):
    """Call OpenWeatherMap Current Weather and return only the fields the app shows."""
    query = urllib.parse.urlencode({**params, "appid": OWM_KEY, "units": "metric"})
    with urllib.request.urlopen(f"{OWM_URL}?{query}", timeout=8) as res:
        raw = json.load(res)
    w = (raw.get("weather") or [{}])[0]
    return {
        "tempC": round(raw["main"]["temp"]),
        "feelsLikeC": round(raw["main"]["feels_like"]),
        "description": w.get("description", ""),
        "icon": w.get("icon", ""),
        "city": raw.get("name", ""),
        "country": raw.get("sys", {}).get("country", ""),
        "capturedAt": int(time.time() * 1000),
        "source": "OpenWeatherMap",
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "geolocation=(self), camera=(), microphone=()")
        self.send_header("Content-Security-Policy", CSP_ENFORCED)
        self.send_header("Content-Security-Policy-Report-Only", CSP_REPORT_ONLY)
        if ON_RENDER:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        # App files: let browsers keep a copy but check for a newer one on every load,
        # so a deploy never leaves someone with old HTML mixed with new CSS/JS.
        # (/api/ responses set their own no-store.)
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        # Don't show folder listings (for example /vendor/) to visitors.
        self.send_error(404, "Not found")
        return None

    def visitor(self):
        """Best guess at who is calling. On Render the real address is in X-Forwarded-For."""
        fwd = self.headers.get("X-Forwarded-For", "")
        if ON_RENDER and fwd:
            return fwd.split(",")[0].strip()
        return self.client_address[0]

    def send_json(self, status, body, extra_headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/weather":
            return self.weather(urllib.parse.parse_qs(url.query))
        if url.path == "/config.js":
            body = "window.DF_CONFIG = " + json.dumps({"posthogKey": POSTHOG_KEY, "posthogHost": POSTHOG_HOST}) + ";\n"
            data = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def weather(self, qs):
        wait = rate_limited(self.visitor())
        if wait:
            print(f"[weather] 429 rate limit for a visitor, retry in {wait}s")
            return self.send_json(429, {"error": "Too many weather requests. Try again in a minute."},
                                  {"Retry-After": str(wait)})
        if not OWM_KEY:
            return self.send_json(503, {"error": "No weather key set. Add OPENWEATHER_API_KEY to .env and restart the server."})
        lat, lon = qs.get("lat", [None])[0], qs.get("lon", [None])[0]
        try:
            # Round to 2 decimals (about 1 km) so we never send a precise location.
            params = {"lat": round(float(lat), 2), "lon": round(float(lon), 2)} if lat and lon else {"q": DEFAULT_CITY}
        except ValueError:
            return self.send_json(400, {"error": "lat and lon must be numbers"})
        if "lat" in params and not (math.isfinite(params["lat"]) and math.isfinite(params["lon"])
                                    and -90 <= params["lat"] <= 90 and -180 <= params["lon"] <= 180):
            return self.send_json(400, {"error": "lat must be -90..90 and lon -180..180"})

        today = time.strftime("%Y-%m-%d")
        if calls_today["date"] != today:
            calls_today.update(date=today, count=0)
        calls_today["count"] += 1
        started = time.time()
        try:
            result = fetch_weather(params)
        except urllib.error.HTTPError as e:
            msg = {
                401: "OpenWeatherMap rejected the key. New keys can take up to 2 hours to start working.",
                404: "OpenWeatherMap could not find that place.",
                429: "Too many weather requests. Free plan allows 60 per minute.",
            }.get(e.code, f"OpenWeatherMap error {e.code}")
            print(f"[weather] HTTP {e.code} for {params}")
            return self.send_json(502, {"error": msg})
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as e:
            print(f"[weather] failed: {e}")
            return self.send_json(502, {"error": "Could not reach OpenWeatherMap. Check your internet connection."})

        ms = int((time.time() - started) * 1000)
        print(f"[weather] {result['city']} {result['tempC']}C {result['description']} · {ms} ms · "
              f"call #{calls_today['count']} today · cost $0.00 (free plan: 60/min, 1M/month)")
        return self.send_json(200, result)

    def log_message(self, fmt, *args):
        # Keep the terminal readable: only log API calls and errors, not every static file.
        if "/api/" in self.path or (len(args) > 1 and str(args[1])[:1] in "45"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"Daily Frame running at http://localhost:{PORT}" + (f" (listening on {HOST})" if ON_RENDER else ""))
    print(f"  Weather: {'key loaded' if OWM_KEY else 'NO KEY (add OPENWEATHER_API_KEY to .env)'}")
    print(f"  PostHog: {'key loaded' if POSTHOG_KEY else 'off (add POSTHOG_KEY to .env)'}")
    print("Press Ctrl+C to stop.")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
