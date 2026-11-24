// Daily Frame: one photo + one reflection per day, stored only in this browser (IndexedDB).

const DB_NAME = 'daily-frame';
const STORE = 'entries'; // key: "YYYY-MM-DD" -> { date, photo: Blob|null, reflection, mood?: 1-5, weather?, updatedAt }

// ---------- storage ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'date' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbPromise = openDB();

async function tx(mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const getEntry = (date) => tx('readonly', (s) => s.get(date));
const putEntry = (entry) => tx('readwrite', (s) => s.put(entry));
const deleteEntry = (date) => tx('readwrite', (s) => s.delete(date));
async function getMonth(year, month) {
  const lo = key(new Date(year, month, 1));
  const hi = key(new Date(year, month + 1, 0));
  return tx('readonly', (s) => s.getAll(IDBKeyRange.bound(lo, hi)));
}

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => key(new Date());
const isFuture = (k) => k > todayKey();

// ---------- image decoding (JPG, PNG, WebP, AVIF, GIF, BMP natively; HEIC/HEIF via vendor/heic-to.js) ----------
async function looksLikeHeic(file) {
  if (/image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '')) return true;
  // Some systems hand over HEIC files with no type, so check the file header too.
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const box = String.fromCharCode(...head.slice(4, 12));
  return /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(box);
}

let heicLib = null;
function loadHeicLib() {
  if (!heicLib) {
    heicLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/heic-to.js';
      s.onload = () => resolve(window.HeicTo);
      s.onerror = () => reject(new Error('Could not load the HEIC converter'));
      document.head.appendChild(s);
    });
  }
  return heicLib;
}

function decodeWithImgTag(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unsupported')); };
    img.src = url;
  });
}

async function decodeImage(file) {
  if (await looksLikeHeic(file)) {
    // Safari can open HEIC by itself; other browsers need the converter.
    try { return await createImageBitmap(file); } catch (_) {}
    const heicTo = await loadHeicLib();
    return heicTo({ blob: file, type: 'bitmap' });
  }
  try { return await createImageBitmap(file); } catch (_) {}
  return decodeWithImgTag(file); // fallback for formats only <img> understands
}

// ---------- image resize (keeps storage small) ----------
async function resizeImage(file, maxSide = 1600) {
  const bitmap = await decodeImage(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
}

// ---------- state ----------
const $ = (id) => document.getElementById(id);
let viewYear, viewMonth, currentDay = null, objectUrls = [];

function revokeUrls() { objectUrls.forEach(URL.revokeObjectURL); objectUrls = []; }
function urlFor(blob) { const u = URL.createObjectURL(blob); objectUrls.push(u); return u; }

// ---------- calendar ----------
async function renderCalendar() {
  revokeUrls();
  const first = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  $('month-label').setAttribute('aria-label', first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  $('month-num').textContent = String(viewMonth + 1).padStart(2, '0');
  $('month-name').textContent = first.toLocaleDateString(undefined, { month: 'long' });
  const yr = String(viewYear);
  $('year-a').textContent = yr.slice(0, 2); $('year-b').textContent = yr.slice(2);

  const entries = await getMonth(viewYear, viewMonth);
  const byDate = Object.fromEntries(entries.map((e) => [e.date, e]));
  const photos = entries.filter((e) => e.photo).length;
  const words = entries.reduce((n, e) => n + (e.reflection?.trim() ? e.reflection.trim().split(/\s+/).length : 0), 0);
  $('month-summary').textContent = entries.length
    ? `${photos} photo${photos === 1 ? '' : 's'} · ${words} word${words === 1 ? '' : 's'} of reflection this month`
    : 'Nothing here yet. Tap a day to start.';

  const grid = $('grid');
  grid.innerHTML = '';
  for (let i = 0; i < first.getDay(); i++) {
    const b = document.createElement('div'); b.className = 'cell blank'; grid.appendChild(b);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const k = key(new Date(viewYear, viewMonth, d));
    const e = byDate[k];
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.style.setProperty('--day-mix', MIX[(d - 1) % MIX.length]);
    cell.setAttribute('aria-label', fromKey(k).toDateString());
    if (k === todayKey()) cell.classList.add('today');
    if (isFuture(k)) { cell.classList.add('future'); cell.disabled = true; }
    if (e?.photo) {
      cell.classList.add('has-photo');
      const img = document.createElement('img'); img.src = urlFor(e.photo); img.alt = ''; img.className = 'ph-no-capture';
      cell.appendChild(img);
    }
    const num = document.createElement('span'); num.className = 'num'; num.textContent = d; cell.appendChild(num);
    if (e?.reflection?.trim()) { const dot = document.createElement('span'); dot.className = 'dot'; cell.appendChild(dot); }
    if (e?.mood) {
      const m = moodImg(e.mood, 'mood-badge');
      cell.appendChild(m);
      cell.setAttribute('aria-label', `${fromKey(k).toDateString()}, mood: ${MOODS[e.mood].name}`);
    }
    cell.addEventListener('click', () => openDay(k));
    grid.appendChild(cell);
  }
  const now = new Date();
  $('next-month').disabled = viewYear > now.getFullYear() || (viewYear === now.getFullYear() && viewMonth >= now.getMonth());
}

function shiftMonth(delta) {
  const d = new Date(viewYear, viewMonth + delta, 1);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  renderCalendar();
}

// ---------- day view ----------
async function openDay(k) {
  await flushReflection(); // finish saving the day we are leaving
  currentDay = k;
  location.hash = k;
  stopCollage();
  $('recap-view').hidden = true;
  $('calendar-view').hidden = true;
  $('day-view').hidden = false;
  $('day-label').textContent = fromKey(k).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('next-day').disabled = k >= todayKey();
  setStatus('');
  const e = await getEntry(k);
  showPhoto(e?.photo || null);
  showWeather(e?.weather || null);
  showMood(e?.mood || null);
  const daysAgo = Math.round((fromKey(todayKey()) - fromKey(k)) / 86400000);
  track('day_opened', { days_ago: daysAgo, has_entry: !!e, has_weather: !!e?.weather });
  // Today's post that has content but no weather yet gets a snapshot now.
  if (e && !e.weather && k === todayKey()) captureWeather(k);
  $('reflection').value = e?.reflection || '';
  // A day that already has writing opens locked; an empty day opens ready to write.
  setReflectionMode(e?.reflection?.trim() ? 'view' : 'edit', false);
  window.scrollTo(0, 0);
}

// ---------- reflection: locked (view) vs editing ----------
function autoGrow() {
  const t = $('reflection');
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 2 + 'px';
}

function setReflectionMode(mode, focus = true) {
  const text = $('reflection').value;
  const editing = mode === 'edit';
  $('reflection-view').textContent = text;
  $('reflection-view').hidden = editing;
  $('reflection').hidden = !editing;
  $('edit-btn').hidden = editing;
  // "Done" only makes sense once there is something written.
  $('done-btn').hidden = !editing || !text.trim();
  if (editing) {
    autoGrow();
    if (focus) {
      const t = $('reflection');
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  }
}

async function flushReflection() {
  if (!typingTimer || !currentDay) return;
  clearTimeout(typingTimer);
  typingTimer = null;
  await save({ reflection: $('reflection').value });
}

async function finishEditing() {
  clearTimeout(typingTimer);
  typingTimer = null;
  await save({ reflection: $('reflection').value });
  const words = $('reflection').value.trim().split(/\s+/).filter(Boolean).length;
  track('reflection_done', { words, is_today: currentDay === todayKey() });
  setReflectionMode($('reflection').value.trim() ? 'view' : 'edit', false);
}

function showPhoto(blob) {
  const img = $('photo');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (blob) {
    const u = URL.createObjectURL(blob);
    img.src = u; img.dataset.url = u; img.hidden = false;
    $('photo-empty').hidden = true; $('photo-actions').hidden = false;
  } else {
    img.hidden = true; img.removeAttribute('src'); delete img.dataset.url;
    $('photo-empty').hidden = false; $('photo-actions').hidden = true;
  }
}

async function save(patch, k = currentDay) {
  const existing = (await getEntry(k)) || { date: k, photo: null, reflection: '' };
  const entry = { ...existing, ...patch, updatedAt: Date.now() };
  if (!entry.photo && !entry.reflection.trim() && !entry.mood) { await deleteEntry(k); return; }
  await putEntry(entry);
  if (k === currentDay) setStatus('Saved on this device');
  // First save of today's post: take a weather snapshot and keep it with the post.
  if (!entry.weather && k === todayKey() && weatherFailedFor !== k) captureWeather(k);
}

// ---------- weather: a snapshot of today's weather, saved with today's post ----------
// The browser asks our own server (server.py), which calls OpenWeatherMap with the key from .env.
// The key never reaches the browser. Past days only show weather if it was captured that day.
const WEATHER_ICONS = { '01d': '☀️', '01n': '🌙', '02d': '🌤️', '02n': '☁️', '03': '☁️', '04': '☁️', '09': '🌧️', '10': '🌦️', '11': '⛈️', '13': '❄️', '50': '🌫️' };
let weatherInFlight = null, weatherFailedFor = null;

function weatherIcon(code = '') { return WEATHER_ICONS[code] || WEATHER_ICONS[code.slice(0, 2)] || '🌡️'; }
const toF = (c) => Math.round(c * 9 / 5 + 32);

function showWeather(w, { loading = false, error = '' } = {}) {
  const box = $('weather');
  $('weather-retry').hidden = !error;
  box.classList.toggle('error', !!error);
  if (loading) {
    box.hidden = false; $('weather-icon').textContent = '⋯'; $('weather-text').textContent = 'Getting today\'s weather…'; return;
  }
  if (error) { box.hidden = false; $('weather-icon').textContent = '⚠️'; $('weather-text').textContent = error; return; }
  if (!w) { box.hidden = true; return; }
  box.hidden = false;
  $('weather-icon').textContent = weatherIcon(w.icon);
  const time = new Date(w.capturedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const place = w.city ? ` · ${w.city}` : '';
  $('weather-text').textContent = `${toF(w.tempC)}°F (${w.tempC}°C) · ${w.description}${place} · ${time}`;
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), () => resolve(null), { timeout: 8000, maximumAge: 30 * 60 * 1000 });
  });
}

function captureWeather(day) {
  if (weatherInFlight) return weatherInFlight;
  weatherInFlight = (async () => {
    if (day === currentDay) showWeather(null, { loading: true });
    const started = performance.now();
    try {
      const c = await getPosition(); // falls back to WEATHER_CITY in .env if location is off
      const qs = c ? `?lat=${c.latitude.toFixed(2)}&lon=${c.longitude.toFixed(2)}` : '';
      const res = await fetch('/api/weather' + qs);
      const data = await res.json().catch(() => ({ error: 'Weather needs the app server. Start it with: python3 server.py' }));
      if (!res.ok || data.error) throw new Error(data.error || 'Weather unavailable right now.');
      weatherFailedFor = null;
      await save({ weather: data }, day);
      if (day === currentDay) showWeather(data);
      track('weather_captured', { ms: Math.round(performance.now() - started), used_location: !!c });
    } catch (err) {
      weatherFailedFor = day; // don't retry on every autosave; the Retry button tries again
      if (day === currentDay) showWeather(null, { error: err.message });
      track('weather_failed', { reason: err.message });
    } finally {
      weatherInFlight = null;
    }
  })();
  return weatherInFlight;
}

function setStatus(text, isError = false) {
  $('save-status').textContent = text;
  $('save-status').classList.toggle('error', isError);
}

async function usePhoto(file) {
  if (!file) return;
  const day = currentDay;
  setStatus((await looksLikeHeic(file)) ? 'Converting HEIC photo…' : 'Saving photo…');
  try {
    const blob = await resizeImage(file);
    if (day !== currentDay) return;
    showPhoto(blob);
    await save({ photo: blob }, day);
    track('photo_added', { is_today: day === todayKey() });
  } catch (err) {
    console.error(err);
    const ext = (file.name.split('.').pop() || 'this').toUpperCase();
    setStatus(`Couldn't open that ${ext} file in this browser. Try JPG, PNG, HEIC, WebP, AVIF, GIF or BMP.`, true);
  }
}

function onPhotoChosen(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  usePhoto(file);
}

let typingTimer = null;
function onReflectionInput() {
  setStatus('Writing…');
  autoGrow();
  $('done-btn').hidden = !$('reflection').value.trim();
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { typingTimer = null; save({ reflection: $('reflection').value }); }, 500);
}

function shiftDay(delta) {
  const d = fromKey(currentDay); d.setDate(d.getDate() + delta);
  const k = key(d);
  if (!isFuture(k)) openDay(k);
}

async function backToCalendar() {
  clearTimeout(typingTimer);
  typingTimer = null;
  if (currentDay) await save({ reflection: $('reflection').value });
  const d = fromKey(currentDay);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  currentDay = null;
  history.replaceState(null, '', location.pathname);
  $('day-view').hidden = true;
  $('calendar-view').hidden = false;
  renderCalendar();
}

// ---------- mood: one of five hand-drawn faces per day, saved as entry.mood (1 = rough ... 5 = amazing) ----------
const MOODS = [null,
  { name: 'Rough' }, { name: 'Down' }, { name: 'Meh' }, { name: 'Good' }, { name: 'Amazing' }];
// Hand-drawn face for a mood (1-5), as an <img>. Decorative: the mood name is given in text or a label nearby.
function moodImg(m, cls = 'mood-face') {
  const i = document.createElement('img'); i.src = `img/mood-${m}.png`; i.alt = ''; i.className = cls; i.draggable = false;
  return i;
}

function showMood(m) {
  document.querySelectorAll('#mood-options button').forEach((b) => {
    const on = Number(b.dataset.mood) === m;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('mood-name').textContent = m ? MOODS[m].name : (currentDay === todayKey() ? 'How did today feel?' : 'How did this day feel?');
}

async function onMoodClick(e) {
  const b = e.target.closest('button[data-mood]');
  if (!b || !currentDay) return;
  const day = currentDay;
  await flushReflection(); // don't lose words typed in the last half second
  const m = Number(b.dataset.mood);
  const next = (await getEntry(day))?.mood === m ? null : m; // tap the same mood again to clear it
  showMood(next);
  await save({ mood: next }, day);
  // Only a flag goes to analytics, never which mood was picked.
  track(next ? 'mood_set' : 'mood_cleared', { is_today: day === todayKey() });
}

// ---------- monthly recap: summary + animated collage, built in this browser from this month's entries ----------
// No AI and no network calls: the "summary" is made from your own words (recurring themes, standout
// sentences) and your moods, so reflections and photos never leave the device.
let recapYear, recapMonth, collageTimer = null, collagePaused = false;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const STOPWORDS = new Set(`a about above after again against all almost also always am an and another any anyone anything
are aren't around as at back be became because been before being below between both but by came can can't cannot come
could couldn't did didn't do does doesn't doing don't done down during each either else enough even ever every everything
few first for from get gets getting got gotten had hadn't has hasn't have haven't having he he'd he'll her here hers herself
him himself his how however i i'd i'll i'm i've if in into is isn't it it'd it'll its itself just keep kind know last least
less let like little lot lots made make makes making many may maybe me might mine more most much must my myself need never
new next no nor not nothing now of off oh ok okay on once one only onto or other others our ours ourselves out over own
pretty put quite rather really right said same say says see seem seemed seems she she'd she'll should shouldn't since so
some somehow something sometimes somewhat still such sure take than that that's the their theirs them themselves then there
there's these they they'd they'll they're they've thing things think this those though through thru to today together too
took toward tried try trying under until up upon us very want wanted was wasn't way we we'd we'll we're we've well went were
weren't what what's whatever when where whether which while who whole whom whose why will with without won't would wouldn't
yeah yes yet you you'd you'll you're you've your yours yourself day days time times bit feel feeling felt going gonna lol
also tonight morning night yesterday tomorrow week`.split(/\s+/));

const mean = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
const shortDate = (k) => fromKey(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const listJoin = (xs) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function shuffle(xs) { for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; }

function wordsOf(text) {
  return (text.toLowerCase().match(/[a-zÀ-ɏ']+/g) || [])
    .map((w) => w.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
function sentencesOf(text) {
  return (text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) || []).map((x) => x.trim()).filter(Boolean);
}

function analyzeMonth(entries) {
  const written = entries.filter((e) => e.reflection?.trim());
  // dayFreq: on how many different days a word shows up. A word used on many days is a theme.
  const dayFreq = new Map(), total = new Map();
  for (const e of written) {
    const ws = wordsOf(e.reflection);
    ws.forEach((w) => total.set(w, (total.get(w) || 0) + 1));
    new Set(ws).forEach((w) => dayFreq.set(w, (dayFreq.get(w) || 0) + 1));
  }
  // Keep names capitalized: a word you always write with a capital (Sam, Brooklyn) stays that way.
  const seenLower = new Set(), seenCap = new Set();
  written.forEach((e) => (e.reflection.match(/[A-Za-z\u00c0-\u024f']+/g) || []).forEach((raw) => {
    const w = raw.toLowerCase().replace(/'s$/, '');
    (raw[0] === raw[0].toLowerCase() ? seenLower : seenCap).add(w);
  }));
  const properNames = new Set([...seenCap].filter((w) => !seenLower.has(w)));
  const minDays = written.length >= 3 ? 2 : 1;
  const themes = [...dayFreq].filter(([, d]) => d >= minDays)
    .sort((a, b) => b[1] - a[1] || total.get(b[0]) - total.get(a[0]))
    .slice(0, 8).map(([word, days]) => ({ word: properNames.has(word) ? word[0].toUpperCase() + word.slice(1) : word, days }));

  // One standout sentence per day (the one most built from this month's recurring words),
  // then the best few across the month, shown in date order.
  const picks = written.map((e) => {
    let best = null;
    for (const text of sentencesOf(e.reflection)) {
      const n = text.split(/\s+/).length;
      if (n < 4 || n > 45) continue;
      const score = wordsOf(text).reduce((t, w) => t + (dayFreq.get(w) || 0), 0) / Math.sqrt(n)
        + (e.mood === 1 || e.mood === 5 ? 1 : 0); // big-feeling days are worth remembering
      if (!best || score > best.score) best = { text, score };
    }
    if (!best) {
      const t = e.reflection.trim().replace(/\s+/g, ' ');
      best = { text: t.length > 220 ? t.slice(0, 217) + '…' : t, score: 0 };
    }
    return { date: e.date, mood: e.mood, ...best };
  });
  const quotes = picks.sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => a.date.localeCompare(b.date));

  const moods = entries.filter((e) => e.mood).sort((a, b) => a.date.localeCompare(b.date));
  const counts = [0, 0, 0, 0, 0, 0];
  moods.forEach((e) => counts[e.mood]++);
  let trend = null;
  if (moods.length >= 4) {
    const half = Math.floor(moods.length / 2);
    const diff = mean(moods.slice(-half).map((e) => e.mood)) - mean(moods.slice(0, half).map((e) => e.mood));
    trend = diff > 0.5 ? 'up' : diff < -0.5 ? 'down' : 'steady';
  }
  const wordCount = (e) => e.reflection.trim().split(/\s+/).length;
  const longest = written.reduce((best, e) => (!best || wordCount(e) > wordCount(best) ? e : best), null);
  const words = written.reduce((n, e) => n + wordCount(e), 0);
  return { written, themes, quotes, moods, counts, trend, longest, longestWords: longest ? wordCount(longest) : 0, words };
}

function summaryText(entries, a, daysSoFar, isThisMonth) {
  const out = [];
  out.push(`You showed up on ${entries.length} of ${daysSoFar} days${isThisMonth ? ' so far' : ''}.`);
  if (a.moods.length) {
    const top = [1, 2, 3, 4, 5].sort((x, y) => a.counts[y] - a.counts[x] || y - x)[0];
    const trend = { up: ' and your mood lifted as the month went on', down: ' and the second half felt heavier than the first', steady: ' and your mood stayed fairly steady' }[a.trend] || '';
    out.push(`Most days felt ${MOODS[top].name.toLowerCase()}${trend}.`);
    const best = a.moods.reduce((b, e) => (e.mood > b.mood ? e : b));
    const worst = a.moods.reduce((b, e) => (e.mood < b.mood ? e : b));
    if (best.mood >= 4) out.push(`Your brightest day was ${shortDate(best.date)}.`);
    if (worst.mood <= 2 && worst !== best) out.push(`${shortDate(worst.date)} was the hardest, and you wrote it down anyway.`);
  }
  const recurring = a.themes.filter((t) => t.days >= 2).slice(0, 3).map((t) => t.word);
  if (recurring.length) out.push(`Your writing kept coming back to ${listJoin(recurring)}.`);
  if (a.longest && a.written.length > 1) out.push(`Your longest reflection was on ${shortDate(a.longest.date)} (${a.longestWords} words).`);
  if (!a.written.length) out.push('No reflections written this month, so this recap is all photos and moods.');
  return out.join(' ');
}

// ---------- the animated collage ----------
// Up to 9 tiles in a 4-column mosaic. Each photo slowly drifts and zooms; every few seconds one tile
// crossfades to a photo that isn't showing yet (or two tiles trade places when every photo is already up).
function tileSpan(i, n) {
  if (n === 1) return [4, 2];
  if (n === 2) return [2, 2];
  if (i === 0) return [2, 2];
  if (n === 3) return [2, 1];
  if (n === 4) return i === 1 ? [2, 1] : [1, 1];
  if (n === 6 && i === 5) return [4, 1];
  if (n === 7 && i >= 5) return [2, 1];
  if (n === 8 && i === 7) return [2, 1];
  return [1, 1];
}

function setTile(tile, entry, url) {
  tile.dataset.date = entry.date;
  tile.querySelector('img').src = url;
  tile.querySelector('.tile-date').textContent = shortDate(entry.date);
  tile.setAttribute('aria-label', `Open ${fromKey(entry.date).toDateString()}`);
}

function stopCollage() { clearInterval(collageTimer); collageTimer = null; }

function buildCollage(photoEntries) {
  stopCollage();
  const box = $('collage');
  box.innerHTML = '';
  $('collage-block').hidden = !photoEntries.length;
  if (!photoEntries.length) return;
  const urls = new Map(photoEntries.map((e) => [e.date, urlFor(e.photo)]));
  const order = shuffle([...photoEntries]);
  const n = Math.min(order.length, 9);
  const pool = order.slice(n); // photos waiting for their turn
  const shown = order.slice(0, n);
  shown.forEach((e, i) => {
    const tile = el('button', 'tile');
    const [c, r] = tileSpan(i, n);
    tile.style.gridColumn = `span ${c}`;
    tile.style.gridRow = `span ${r}`;
    tile.style.setProperty('--i', i);
    tile.style.setProperty('--dx', `${(Math.random() * 6 - 3).toFixed(1)}%`);
    tile.style.setProperty('--dy', `${(Math.random() * 6 - 3).toFixed(1)}%`);
    tile.append(el('img'), el('span', 'tile-date'));
    tile.querySelector('img').alt = '';
    setTile(tile, e, urls.get(e.date));
    tile.onclick = () => openDay(tile.dataset.date);
    box.appendChild(tile);
  });

  const tiles = [...box.children];
  const fadeSwap = (tile, entry) => {
    tile.classList.add('swapping');
    setTimeout(() => { setTile(tile, entry, urls.get(entry.date)); tile.classList.remove('swapping'); }, 450);
  };
  if (n < 2) return;
  collageTimer = setInterval(() => {
    if (collagePaused || document.hidden) return;
    const i = Math.floor(Math.random() * n);
    if (pool.length) {
      pool.push(shown[i]);
      shown[i] = pool.shift();
      fadeSwap(tiles[i], shown[i]);
    } else {
      let j = Math.floor(Math.random() * (n - 1)); if (j >= i) j++;
      [shown[i], shown[j]] = [shown[j], shown[i]];
      fadeSwap(tiles[i], shown[i]); fadeSwap(tiles[j], shown[j]);
    }
  }, 2800);
}

function setCollagePaused(paused) {
  collagePaused = paused;
  $('collage').classList.toggle('paused', paused);
  $('collage-toggle').textContent = paused ? '▶ Play' : '❚❚ Pause';
  $('collage-toggle').setAttribute('aria-pressed', String(paused));
}

// ---------- recap view ----------
async function openRecap(y, m) {
  await flushReflection();
  recapYear = y; recapMonth = m;
  revokeUrls();
  currentDay = null;
  history.replaceState(null, '', `#recap-${y}-${pad(m + 1)}`);
  $('calendar-view').hidden = true;
  $('day-view').hidden = true;
  $('recap-view').hidden = false;

  const first = new Date(y, m, 1);
  const now = new Date();
  const isThisMonth = y === now.getFullYear() && m === now.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysSoFar = isThisMonth ? now.getDate() : daysInMonth;
  $('recap-label').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('recap-next').disabled = y > now.getFullYear() || (y === now.getFullYear() && m >= now.getMonth());

  const entries = (await getMonth(y, m)).sort((a, b) => a.date.localeCompare(b.date));
  const photos = entries.filter((e) => e.photo);
  const a = analyzeMonth(entries);
  $('recap-empty').hidden = !!entries.length;
  $('recap-body').hidden = !entries.length;
  $('recap-stats').textContent = entries.length
    ? `${entries.length} day${entries.length === 1 ? '' : 's'} · ${photos.length} photo${photos.length === 1 ? '' : 's'} · ${a.words} word${a.words === 1 ? '' : 's'} · ${a.moods.length} mood${a.moods.length === 1 ? '' : 's'}`
    : '';
  window.scrollTo(0, 0);
  track('recap_opened', { is_this_month: isThisMonth, days: entries.length, photos: photos.length, moods: a.moods.length });
  if (!entries.length) { stopCollage(); return; }

  setCollagePaused(reduceMotion.matches); // respect "reduce motion": start still, Play is one tap away
  buildCollage(photos);

  $('recap-summary').textContent = summaryText(entries, a, daysSoFar, isThisMonth);
  const themes = $('recap-themes');
  themes.innerHTML = '';
  a.themes.forEach((t) => {
    const chip = el('span', 'chip', t.word);
    if (t.days > 1) chip.append(el('small', null, ` ${t.days} days`));
    themes.appendChild(chip);
  });

  $('recap-mood-card').hidden = !a.moods.length;
  const bars = $('recap-mood-bars');
  bars.innerHTML = '';
  const maxCount = Math.max(1, ...a.counts);
  for (let v = 5; v >= 1; v--) {
    const row = el('div', 'mood-bar');
    const fill = el('span', 'fill');
    fill.style.width = `${(a.counts[v] / maxCount) * 100}%`;
    const track_ = el('span', 'bar-track'); track_.appendChild(fill);
    const face = el('span', 'bar-emoji'); face.append(moodImg(v));
    row.append(face, track_, el('span', 'bar-count', String(a.counts[v])));
    row.setAttribute('aria-label', `${MOODS[v].name}: ${a.counts[v]} day${a.counts[v] === 1 ? '' : 's'}`);
    bars.appendChild(row);
  }
  const strip = $('recap-mood-strip');
  strip.innerHTML = '';
  const byDate = Object.fromEntries(entries.map((e) => [e.date, e]));
  for (let d = 1; d <= daysSoFar; d++) {
    const k = key(new Date(y, m, d));
    const mood = byDate[k]?.mood;
    const b = el('button', 'strip-day' + (mood ? '' : ' none')); if (mood) b.append(moodImg(mood));
    b.title = `${shortDate(k)}${mood ? ': ' + MOODS[mood].name : ''}`;
    b.setAttribute('aria-label', b.title);
    b.onclick = () => openDay(k);
    strip.appendChild(b);
  }

  $('recap-quotes-card').hidden = !a.quotes.length;
  const quotes = $('recap-quotes');
  quotes.innerHTML = '';
  a.quotes.forEach((q) => {
    const fig = el('button', 'quote');
    fig.append(el('span', 'quote-text', `“${q.text}”`), (() => { const d = el('span', 'quote-date', shortDate(q.date)); if (q.mood) d.append(moodImg(q.mood, 'mood-face inline')); return d; })());
    fig.onclick = () => openDay(q.date);
    quotes.appendChild(fig);
  });
}

function shiftRecap(delta) {
  const d = new Date(recapYear, recapMonth + delta, 1);
  openRecap(d.getFullYear(), d.getMonth());
}

function backFromRecap() {
  stopCollage();
  viewYear = recapYear; viewMonth = recapMonth;
  history.replaceState(null, '', location.pathname);
  $('recap-view').hidden = true;
  $('calendar-view').hidden = false;
  renderCalendar();
}

// ---------- theme ----------
const MIX = ['var(--pink)', 'var(--orchid)', 'var(--lavender)', 'var(--blue)', 'var(--sky)'];
const root = document.documentElement;

function store(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

// Two themes only: Day (light) and Night (dark).
function applyTheme() {
  document.querySelectorAll('#mode-options button').forEach((b) => {
    const on = b.dataset.mode === root.dataset.mode;
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
}
$('mode-options').onclick = (e) => {
  const m = e.target.closest('button')?.dataset.mode; if (!m) return;
  root.dataset.mode = m; store('df-mode', m); applyTheme();
};
applyTheme();

// ---------- drag and drop a photo onto the day view ----------
const wrap = $('photo-wrap');
['dragenter', 'dragover'].forEach((t) => wrap.addEventListener(t, (e) => { e.preventDefault(); wrap.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => wrap.addEventListener(t, (e) => { e.preventDefault(); wrap.classList.remove('dragging'); }));
wrap.addEventListener('drop', (e) => usePhoto(e.dataTransfer.files[0]));

// ---------- wire up ----------
$('prev-month').onclick = () => shiftMonth(-1);
$('next-month').onclick = () => shiftMonth(1);
$('today-btn').onclick = () => openDay(todayKey());
$('back-btn').onclick = backToCalendar;
$('prev-day').onclick = () => shiftDay(-1);
$('next-day').onclick = () => shiftDay(1);
$('photo-input').onchange = onPhotoChosen;
$('replace-input').onchange = onPhotoChosen;
$('reflection').addEventListener('input', onReflectionInput);
$('edit-btn').onclick = () => setReflectionMode('edit');
$('done-btn').onclick = finishEditing;
$('mood-options').onclick = onMoodClick;
$('recap-btn').onclick = () => openRecap(viewYear, viewMonth);
$('recap-back').onclick = backFromRecap;
$('recap-prev').onclick = () => shiftRecap(-1);
$('recap-next').onclick = () => shiftRecap(1);
$('collage-toggle').onclick = () => setCollagePaused(!collagePaused);
$('weather-retry').onclick = () => { weatherFailedFor = null; captureWeather(currentDay); };
$('delete-btn').onclick = async () => {
  if (!confirm('Delete this day\'s photo and reflection?')) return;
  clearTimeout(typingTimer);
  typingTimer = null;
  await deleteEntry(currentDay);
  showPhoto(null); showWeather(null); showMood(null); $('reflection').value = '';
  track('day_deleted');
  setReflectionMode('edit', false);
  setStatus('Deleted');
};

const now = new Date();
viewYear = now.getFullYear(); viewMonth = now.getMonth();
const recapHash = location.hash.match(/^#recap-(\d{4})-(\d{2})$/);
if (/^\d{4}-\d{2}-\d{2}$/.test(location.hash.slice(1)) && !isFuture(location.hash.slice(1))) openDay(location.hash.slice(1));
else if (recapHash) openRecap(Number(recapHash[1]), Number(recapHash[2]) - 1);
else renderCalendar();
