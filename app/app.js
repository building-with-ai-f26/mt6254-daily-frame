// Daily Frame: one photo + one reflection per day, stored only in this browser (IndexedDB).

const DB_NAME = 'daily-frame';
const STORE = 'entries'; // key: "YYYY-MM-DD" -> { date, photo: Blob|null, reflection, updatedAt }

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

// ---------- image resize (keeps storage small) ----------
async function resizeImage(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
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
  $('month-label').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

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
    cell.setAttribute('aria-label', fromKey(k).toDateString());
    if (k === todayKey()) cell.classList.add('today');
    if (isFuture(k)) { cell.classList.add('future'); cell.disabled = true; }
    if (e?.photo) {
      cell.classList.add('has-photo');
      const img = document.createElement('img'); img.src = urlFor(e.photo); img.alt = '';
      cell.appendChild(img);
    }
    const num = document.createElement('span'); num.className = 'num'; num.textContent = d; cell.appendChild(num);
    if (e?.reflection?.trim()) { const dot = document.createElement('span'); dot.className = 'dot'; cell.appendChild(dot); }
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
  currentDay = k;
  location.hash = k;
  $('calendar-view').hidden = true;
  $('day-view').hidden = false;
  $('day-label').textContent = fromKey(k).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('next-day').disabled = k >= todayKey();
  $('save-status').textContent = '';
  const e = await getEntry(k);
  showPhoto(e?.photo || null);
  $('reflection').value = e?.reflection || '';
  window.scrollTo(0, 0);
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

async function save(patch) {
  const k = currentDay;
  const existing = (await getEntry(k)) || { date: k, photo: null, reflection: '' };
  const entry = { ...existing, ...patch, updatedAt: Date.now() };
  if (!entry.photo && !entry.reflection.trim()) await deleteEntry(k);
  else await putEntry(entry);
  $('save-status').textContent = 'Saved on this device';
}

async function onPhotoChosen(ev) {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  $('save-status').textContent = 'Saving photo…';
  const blob = await resizeImage(file);
  showPhoto(blob);
  await save({ photo: blob });
}

let typingTimer;
function onReflectionInput() {
  $('save-status').textContent = 'Writing…';
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => save({ reflection: $('reflection').value }), 500);
}

function shiftDay(delta) {
  const d = fromKey(currentDay); d.setDate(d.getDate() + delta);
  const k = key(d);
  if (!isFuture(k)) openDay(k);
}

async function backToCalendar() {
  clearTimeout(typingTimer);
  if (currentDay) await save({ reflection: $('reflection').value });
  const d = fromKey(currentDay);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  currentDay = null;
  history.replaceState(null, '', location.pathname);
  $('day-view').hidden = true;
  $('calendar-view').hidden = false;
  renderCalendar();
}

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
$('delete-btn').onclick = async () => {
  if (!confirm('Delete this day\'s photo and reflection?')) return;
  await deleteEntry(currentDay);
  showPhoto(null); $('reflection').value = '';
  $('save-status').textContent = 'Deleted';
};

const now = new Date();
viewYear = now.getFullYear(); viewMonth = now.getMonth();
if (/^\d{4}-\d{2}-\d{2}$/.test(location.hash.slice(1)) && !isFuture(location.hash.slice(1))) openDay(location.hash.slice(1));
else renderCalendar();
