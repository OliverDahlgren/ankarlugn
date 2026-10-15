'use strict';

// --- Inställningar för bedömningen (se method.html) ---
const SMHI_URL = (lat, lon) =>
  `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`;
// Vinden antas kunna vrida ±10° kring prognosen det första dygnet, och mer ju längre fram
// prognosen gäller (prognoser för vindriktning blir osäkrare med tiden), som mest ±30°.
const SPREAD_MIN_DEG = 10;
const SPREAD_PER_DAY_DEG = 7.5;
const SPREAD_MAX_DEG = 30;
// Gränser per båtstorlek: signifikant våghöjd (m) och byvind (m/s) för gult respektive rött.
// Bedömningar, inte mätta värden: en mindre båt rör sig mer i samma sjö.
const BOATS = {
  liten:  { label: 'liten båt (under 8 m)',  waveY: 0.15, waveR: 0.3,  gustY: 15, gustR: 21 },
  mellan: { label: 'mellanstor båt (8–12 m)', waveY: 0.2,  waveR: 0.4,  gustY: 18, gustR: 24 },
  stor:   { label: 'stor båt (över 12 m)',   waveY: 0.3,  waveR: 0.55, gustY: 21, gustR: 27 },
};
// OSM:s färjeleder skiljer inte stora färjor från skärgårdsbåtar, så varningen gäller all linjetrafik.
const FERRY_NEAR_M = 200;       // linjetrafik närmare än så: räkna med svall (märke i listan)
const FERRY_SOME_M = 500;       // närmare än så: svall kan förekomma (bara text)
const SHELTERED_M = 1000;       // stryklängd under detta räknas som skyddat håll
const EXPOSED_M = 3000;         // stryklängd över detta räknas som öppet håll
const TZ = 'Europe/Stockholm';
const COLORS = { green: '#2e9e5b', yellow: '#d9a400', red: '#d64541', grey: '#8a949b' };
const LEVEL = { green: 0, yellow: 1, red: 2 };
const COMPASS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSV', 'SV', 'VSV', 'V', 'VNV', 'NV', 'NNV'];

const fmtHour = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtClock = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', timeZone: TZ });
const fmtClockMin = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

let profiles = null;
let map, markers = {}, rayLayer, myPos = null, myMarker = null, lastRun = null;
const forecastCache = new Map();

function compass(deg) {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function boat() {
  const el = document.getElementById('boat');
  return BOATS[el && el.value] || BOATS.mellan;
}

// Hur mycket vinden antas kunna vrida, beroende på hur långt fram i tiden timmen ligger.
function spreadFor(t) {
  const daysAhead = Math.max(0, (t - Date.now()) / 864e5 - 1);
  return Math.min(SPREAD_MAX_DEG, SPREAD_MIN_DEG + SPREAD_PER_DAY_DEG * daysAhead);
}

// Stryklängd i vindens riktning: största värdet inom ±spread grader, eftersom vinden pendlar.
function fetchFor(place, dirDeg, spread = SPREAD_MIN_DEG) {
  const n = place.fetch_m.length;
  const step = 360 / n;
  let worst = 0;
  for (let d = dirDeg - spread; d <= dirDeg + spread; d += step / 2) {
    const i = Math.round((((d % 360) + 360) % 360) / step) % n;
    worst = Math.max(worst, place.fetch_m[i]);
  }
  return worst;
}

// Korrektionsfaktor från kalibreringen mot vågbojen (data/calibration.json, se method.html).
let waveFactor = 1;

// Signifikant våghöjd för stryklängdsbegränsad sjö (JONSWAP): Hs = 0.0016 · U · √(F/g).
function waveHeight(windMs, fetchM) {
  return waveFactor * 0.0016 * windMs * Math.sqrt(fetchM / 9.81);
}

function rateHour(place, h) {
  const b = boat();
  const spread = spreadFor(h.t);
  const fetch = fetchFor(place, h.dir, spread);
  const hs = waveHeight(h.wind, fetch);
  let cls = hs >= b.waveR ? 'red' : hs >= b.waveY ? 'yellow' : 'green';
  if (h.gust >= b.gustR) cls = 'red';
  else if (h.gust >= b.gustY && cls === 'green') cls = 'yellow';
  // Helt öppet mot havet: dyning kan komma in även i måttlig vind.
  if (fetch >= profiles.max_fetch_m && h.wind >= 6 && cls === 'green') cls = 'yellow';
  return { ...h, fetch, hs, cls, spread };
}

// Sammanhängande sektorer (cirkulärt) där pred(stryklängd) är sann, som text "SV–NV".
function sectors(place, pred) {
  const f = place.fetch_m, n = f.length, step = 360 / n;
  const ok = f.map(pred);
  if (ok.every(Boolean)) return ['alla håll'];
  if (!ok.some(Boolean)) return [];
  let start = ok.findIndex((v, i) => !v);   // börja på ett "falskt" index så att inga sektorer delas
  const runs = [];
  let cur = null;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (ok[i]) {
      if (!cur) cur = { from: i, to: i }; else cur.to = i;
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs.map(r => {
    const a = compass(r.from * step), b = compass(r.to * step);
    return a === b ? a : `${a}–${b}`;
  }).filter((s, i, arr) => arr.indexOf(s) === i);
}

function ferryNote(place) {
  const d = place.ferry_m;
  if (d == null || d >= FERRY_SOME_M) return '';
  const m = `${Math.round(d / 50) * 50} m`;
  return d < FERRY_NEAR_M
    ? `Linjetrafik passerar eller lägger till ${m} bort: räkna med svall, som modellen inte räknar med.`
    : `Linjetrafik inom ${m}: svall kan förekomma.`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' och ' + items[items.length - 1];
}

function describe(place, hours, worst) {
  const n = place.fetch_m.length;
  const prot = sectors(place, d => d < SHELTERED_M);
  const unprot = sectors(place, d => d >= SHELTERED_M);
  const open = sectors(place, d => d >= EXPOSED_M);
  const protCount = place.fetch_m.filter(d => d < SHELTERED_M).length;
  const km = d => (d / 1000).toFixed(1).replace('.', ',');
  const parts = [];
  if (prot[0] === 'alla håll') parts.push('Skyddad från alla håll.');
  else if (protCount >= n / 2) parts.push(`Skyddad från alla håll utom ${joinList(unprot)}.`);
  else if (prot.length) parts.push(`Skyddad för vind från ${joinList(prot)}.`);
  else parts.push('Saknar riktigt skyddade vindriktningar.');
  if (open.length && open[0] !== 'alla håll') {
    parts.push(`Öppen mot ${joinList(open)} (upp till ${km(Math.max(...place.fetch_m))} km öppet vatten).`);
  }

  const ferry = ferryNote(place);
  if (ferry) parts.push(ferry);

  if (!hours.length) return parts.join(' ');
  if (worst.cls === 'green') {
    const dirs = [...new Set(hours.map(h => compass(h.dir)))];
    parts.push(`Prognosens vind (${dirs.slice(0, 4).join(', ')}) kommer från skyddade håll hela vistelsen.`);
  } else {
    const first = hours.find(h => h.cls === worst.cls);
    const atStart = first === hours[0];
    const when = atStart ? 'redan vid ankomst' : `från ${fmtHour.format(first.t)}`;
    const reason = first.hs >= boat().waveY
      ? `${(first.fetch / 1000).toFixed(1).replace('.', ',')} km öppet vatten, ca ${first.hs.toFixed(1).replace('.', ',')} m sjö`
      : 'kraftiga byar';
    parts.push(`Utsatt när vinden kommer från ${compass(first.dir)}, vilket prognosen visar ${when} (${Math.round(first.wind)} m/s, byar ${Math.round(first.gust)} m/s; ${reason}).`);
  }
  return parts.join(' ');
}

const FORECAST_MAX_AGE_MS = 30 * 60 * 1000;   // hämta om prognosen om sidan stått öppen länge
const STALE_FORECAST_MS = 3 * 3600 * 1000;      // äldre prognos än så: säg det tydligt

async function loadForecast(place) {
  // SMHI:s rutnät är 2,5 km, så avrunda för att återanvända svar för närliggande platser.
  const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  const cached = forecastCache.get(key);
  if (!cached || Date.now() - cached.at > FORECAST_MAX_AGE_MS) {
    const promise = fetch(SMHI_URL(place.lat, place.lon)).then(r => {
      if (!r.ok) throw new Error(`SMHI svarade ${r.status}`);
      return r.json();
    }).then(j => {
      const series = j.timeSeries.map(s => ({
        t: new Date(s.time),
        dir: s.data.wind_from_direction,
        wind: s.data.wind_speed,
        gust: s.data.wind_speed_of_gust ?? s.data.wind_speed,
      })).filter(s => s.dir != null && s.wind != null);
      // När prognosen gjordes. Utan täckning kommer svaret från sparad kopia och kan vara gammalt.
      series.created = new Date(j.createdTime || j.referenceTime || Date.now());
      return series;
    });
    // Misslyckade hämtningar ska inte fastna i minnet.
    promise.catch(() => { if (forecastCache.get(key)?.promise === promise) forecastCache.delete(key); });
    forecastCache.set(key, { at: Date.now(), promise });
  }
  return forecastCache.get(key).promise;
}

// Prognosen per timme mellan ankomst och avfärd. Efter de första dygnen har SMHI glesare
// tidssteg; då används närmaste tidpunkt.
function hoursInStay(series, arrive, depart) {
  const out = [];
  const t0 = new Date(Math.floor(arrive.getTime() / 3.6e6) * 3.6e6);
  for (let t = t0; t <= depart; t = new Date(t.getTime() + 3.6e6)) {
    if (t < series[0].t.getTime() - 3.6e6 || t > series[series.length - 1].t) continue;
    let best = series[0];
    for (const s of series) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    out.push({ ...best, t });
  }
  return out;
}

function roseSvg(place, hours) {
  const n = place.fetch_m.length, step = 360 / n, R = 60, c = 70;
  const scale = d => R * Math.min(1, Math.sqrt(d / profiles.max_fetch_m));
  const pts = place.fetch_m.map((d, i) => {
    const a = (i * step) * Math.PI / 180;
    return `${(c + Math.sin(a) * scale(d)).toFixed(1)},${(c - Math.cos(a) * scale(d)).toFixed(1)}`;
  }).join(' ');
  const wind = [...new Set(hours.map(h => Math.round(h.dir / 10) * 10))].map(dir => {
    const a = dir * Math.PI / 180, h = hours.find(x => Math.round(x.dir / 10) * 10 === dir);
    return `<line x1="${c + Math.sin(a) * (R + 8)}" y1="${c - Math.cos(a) * (R + 8)}" x2="${c + Math.sin(a) * (R - 6)}" y2="${c - Math.cos(a) * (R - 6)}" stroke="${COLORS[h.cls]}" stroke-width="3"/>`;
  }).join('');
  return `<svg class="rose" width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Stryklängd per riktning">
    <circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="#bbb" stroke-dasharray="2 3"/>
    <circle cx="${c}" cy="${c}" r="${scale(1000)}" fill="none" stroke="#ccc"/>
    <polygon points="${pts}" fill="rgba(31,95,139,.25)" stroke="#1f5f8b"/>
    ${wind}
    <text x="${c}" y="9" text-anchor="middle" font-size="10">N</text>
    <text x="${c}" y="139" text-anchor="middle" font-size="10">S</text>
    <text x="3" y="${c + 3}" font-size="10">V</text>
    <text x="131" y="${c + 3}" font-size="10">O</text>
  </svg><div class="why" style="text-align:center">Blått = effektiv stryklängd per riktning (inre ring 1 km, yttre 20 km).<br>Streck = prognosens vindriktningar.</div>`;
}

function timeline(hours) {
  return `<span class="timeline" title="Varje ruta är en timme">${hours.map(h =>
    `<span class="${h.cls}" title="${fmtHour.format(h.t)}: ${compass(h.dir)} ${Math.round(h.wind)} (${Math.round(h.gust)}) m/s"></span>`).join('')}</span>`;
}

function drawRays(place) {
  rayLayer.clearLayers();
  const step = 360 / place.ray_m.length;
  place.ray_m.forEach((d, i) => {
    const a = i * step * Math.PI / 180;
    const dLat = Math.cos(a) * d / 111320;
    const dLon = Math.sin(a) * d / (111320 * Math.cos(place.lat * Math.PI / 180));
    L.polyline([[place.lat, place.lon], [place.lat + dLat, place.lon + dLon]],
      { color: d >= EXPOSED_M ? COLORS.red : d < SHELTERED_M ? COLORS.green : COLORS.yellow, weight: 1.5, opacity: 0.8, interactive: false })
      .addTo(rayLayer);
  });
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }

let evalRun = 0;

async function evaluate(arrive, depart) {
  const run = ++evalRun;
  setStatus('Hämtar prognos från SMHI …');
  if (!lastRun) showLoading();
  const results = await Promise.all(profiles.places.map(async place => {
    try {
      const series = await loadForecast(place);
      const hours = hoursInStay(series, arrive, depart).map(h => rateHour(place, h));
      if (!hours.length) return { place, hours, worst: null, error: 'Ingen prognos för den tiden' };
      const worst = hours.reduce((a, b) =>
        LEVEL[b.cls] > LEVEL[a.cls] || (LEVEL[b.cls] === LEVEL[a.cls] && b.hs > a.hs) ? b : a);
      const lastForecast = series[series.length - 1].t;
      return { place, hours, worst, truncated: depart > lastForecast, lastForecast, created: series.created };
    } catch (e) {
      return { place, hours: [], worst: null, error: e.message };
    }
  }));

  results.sort((a, b) => {
    if (!a.worst || !b.worst) return (a.worst ? 0 : 1) - (b.worst ? 0 : 1);
    return LEVEL[a.worst.cls] - LEVEL[b.worst.cls] || a.worst.hs - b.worst.hs || a.worst.gust - b.worst.gust;
  });
  if (run !== evalRun) return;   // ett nyare val har redan startat
  lastRun = { results, arrive, depart };
  render();
}

// Avstånd fågelvägen i km (haversine).
function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

const KIND_GROUPS = { hamn: ['gästhamn', 'naturhamn'], bad: ['strand', 'vik'] };

function matchesFilters(place) {
  const kind = document.getElementById('kind').value;
  if (kind !== 'alla' && !KIND_GROUPS[kind].includes(place.kind)) return false;
  const radius = Number(document.getElementById('radius').value);
  if (myPos && radius && place.dist > radius) return false;
  return true;
}

const STATUS_LABEL = { green: 'Skyddat hela tiden', yellow: 'Visst sjöhävning', red: 'Utsatt', grey: 'Ingen prognos' };
const STATUS_ICON = {
  green: '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  yellow: '<path d="M8 3.5v5.5M8 12.2v.3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  red: '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  grey: '<circle cx="8" cy="8" r="2" fill="currentColor"/>',
};

function esc(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Färg visas alltid tillsammans med ikon och text, så att den inte är enda bäraren av information.
function statusBadge(cls) {
  return `<span class="status-badge ${cls}"><svg viewBox="0 0 16 16" aria-hidden="true">${STATUS_ICON[cls]}</svg>${STATUS_LABEL[cls]}</span>`;
}

function km(d) { return `${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} km`; }

// En kort mening om varför platsen har den färg den har, för kort och lista.
function shortReason(r) {
  if (r.error || !r.worst) return r.error || 'Ingen prognos';
  const w = r.worst;
  const sea = `${w.hs.toFixed(1).replace('.', ',')} m sjö`;
  if (w.cls === 'green') return w.hs < 0.1 ? 'Lä hela tiden · knappt någon sjö' : `Lä hela tiden · högst ${sea}`;
  const first = r.hours.find(h => h.cls === w.cls);
  const when = first === r.hours[0] ? 'redan vid ankomst' : `från ${fmtClockMin.format(first.t)}`;
  return `${w.cls === 'red' ? 'Utsatt' : 'Sjöhävning'} ${when} · vind ${compass(first.dir)}, ${sea}`;
}

// En rad i listorna (alla platser, favoriter, sökresultat).
function placeRow(r) {
  const cls = r.worst ? r.worst.cls : 'grey';
  const dist = r.place.dist != null ? ` · ${km(r.place.dist)}` : '';
  const swell = r.place.ferry_m != null && r.place.ferry_m < FERRY_NEAR_M ? ' <span class="badge" title="Linjetrafik nära">svall</span>' : '';
  const star = favs.has(r.place.id) ? ' <span class="fav-star" title="Favorit" aria-hidden="true">★</span>' : '';
  const li = document.createElement('li');
  li.innerHTML = `<button type="button" class="place-btn" data-id="${esc(r.place.id)}" aria-label="${esc(r.place.name)}${favs.has(r.place.id) ? ', favorit' : ''}, ${STATUS_LABEL[cls]}. Visa detaljer">
    <span class="name">${esc(r.place.name)}</span>${star} <span class="dot ${cls}" aria-hidden="true"></span>${swell}<br>
    <span class="why">${esc(r.place.kind)}${dist} · ${esc(shortReason(r))}</span>${r.hours.length ? timeline(r.hours) : ''}</button>`;
  li.querySelector('button').addEventListener('click', () => openPlace(r.place.id));
  return li;
}

// Sök utan att bry sig om stora bokstäver eller prickar och ringar: "moja" hittar "Möja".
function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Favoriter sparas bara i den här webbläsaren.
const favs = new Set((() => { try { return JSON.parse(localStorage.getItem('ankarlugn-favs') || '[]'); } catch { return []; } })());

function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  try { localStorage.setItem('ankarlugn-favs', JSON.stringify([...favs])); } catch {}
  render();
}

function render() {
  if (!lastRun) return;
  const { results, arrive, depart } = lastRun;
  for (const r of results) {
    r.place.dist = myPos ? distanceKm(myPos.lat, myPos.lon, r.place.lat, r.place.lon) : null;
  }
  const shown = results.filter(r => matchesFilters(r.place));
  renderBest(shown);

  const query = normalize(document.getElementById('search').value.trim());
  const searching = query.length > 0;
  document.getElementById('view-list').classList.toggle('searching', searching);
  for (const r of results) {
    const cls = r.worst ? r.worst.cls : 'grey';
    const visible = shown.includes(r);
    markers[r.place.id].setStyle({
      fillColor: COLORS[cls], fillOpacity: visible ? 0.95 : 0.15, opacity: visible ? 1 : 0.3,
      color: favs.has(r.place.id) ? '#f2b84b' : '#fff', weight: favs.has(r.place.id) ? 3 : 2,
    });
  }

  // Favoriter: alltid med, oavsett filter, i samma ordning som rangordningen.
  const favRows = results.filter(r => favs.has(r.place.id));
  const favList = document.getElementById('fav-list');
  favList.innerHTML = '';
  favRows.forEach(r => favList.appendChild(placeRow(r)));
  document.getElementById('favs').hidden = searching || !favRows.length;

  const list = document.getElementById('ranking');
  list.innerHTML = '';
  // Sökträffar där namnet börjar med sökordet först, sedan i rangordning.
  const rows = searching
    ? results.filter(r => normalize(r.place.name).includes(query))
      .sort((a, b) => Number(!normalize(a.place.name).startsWith(query)) - Number(!normalize(b.place.name).startsWith(query)))
    : shown;
  rows.forEach(r => list.appendChild(placeRow(r)));
  document.getElementById('list-title').textContent = searching ? `Sökresultat (${rows.length})` : 'Alla platser';
  if (!rows.length) {
    list.innerHTML = searching
      ? '<li class="empty-state">Ingen plats matchar sökningen. Platserna kommer från OpenStreetMap.</li>'
      : '<li class="empty-state">Inga platser matchar filtret. Öka avståndet eller visa alla typer.</li>';
  }

  const truncated = results.find(r => r.truncated);
  const failed = results.filter(r => r.error).length;
  setStatus([
    `${shown.length} av ${results.length} platser.`,
    myPos ? 'Avstånd fågelvägen.' : '',
    truncated ? `Prognosen räcker bara till ${fmtHour.format(truncated.lastForecast)}.` : '',
    failed ? `${failed} platser saknar prognos.` : '',
  ].filter(Boolean).join(' '));
  showForecastAge(results);
  if (currentPlaceId) renderDetail(currentPlaceId);
}

// --- Svaret först: de tre bästa platserna för vistelsen ---
function renderBest(shown) {
  const preset = document.querySelector('.chip[aria-pressed="true"]')?.dataset.preset;
  document.getElementById('best-title').textContent =
    { tonight: 'Bäst för i natt', tomorrow: 'Bäst för i morgon natt', weekend: 'Bäst för helgen', short: 'Bäst just nu' }[preset]
    || 'Bäst för din vistelse';
  document.getElementById('best-when').textContent = `${fmtWhen.format(stay.arrive)} → ${fmtWhen.format(stay.depart)} · ändra`;
  const box = document.getElementById('best-cards');
  const top = shown.filter(r => r.worst).slice(0, 3);
  if (!top.length) {
    const allFailed = lastRun.results.every(r => r.error);
    box.innerHTML = allFailed
      ? '<div class="empty-state">Prognosen kunde inte hämtas. Kontrollera täckningen.<br><button type="button" id="retry">Försök igen</button></div>'
      : '<div class="empty-state">Inga platser matchar filtret. Öka avståndet eller visa alla typer.</div>';
    document.getElementById('retry')?.addEventListener('click', () => { forecastCache.clear(); evaluate(stay.arrive, stay.depart); });
    return;
  }
  box.innerHTML = '';
  top.forEach((r, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'best-card';
    b.setAttribute('aria-label', `${i + 1}. ${r.place.name}, ${STATUS_LABEL[r.worst.cls]}. ${shortReason(r)}`);
    b.innerHTML = `<span class="best-rank" aria-hidden="true">${i + 1}</span>
      <span><span class="best-name">${esc(r.place.name)}</span><span class="best-why">${statusBadge(r.worst.cls)}${esc(shortReason(r))}</span></span>
      <span class="best-dist">${r.place.dist != null ? km(r.place.dist) : ''}</span>`;
    b.addEventListener('click', () => openPlace(r.place.id));
    box.appendChild(b);
  });
}

function showLoading() {
  document.getElementById('best-cards').innerHTML = '<div class="skeleton card"></div>'.repeat(3);
  document.getElementById('ranking').innerHTML = '<li class="skeleton row"></li>'.repeat(6);
}

// --- Detaljvy för en plats ---
let currentPlaceId = null, listScroll = 0;

function openPlace(id) {
  if (location.hash !== `#plats=${id}`) location.hash = `plats=${id}`;
  else showDetail(id);
}

function showDetail(id) {
  const place = profiles.places.find(p => p.id === id);
  if (!place) return;
  const scroller = document.getElementById('panel-scroll');
  if (!currentPlaceId) listScroll = scroller.scrollTop;
  currentPlaceId = id;
  document.getElementById('view-list').hidden = true;
  document.getElementById('view-detail').hidden = false;
  renderDetail(id);
  scroller.scrollTop = 0;
  drawRays(place);
  const mobile = window.matchMedia('(max-width: 899px)').matches;
  setSnap(mobile ? 'half' : null);
  map.setView([place.lat, place.lon], Math.max(map.getZoom(), 13), { animate: false });
  // På mobil täcker bladet kartans nedre del: flytta platsen till mitten av den synliga delen.
  if (mobile) map.panBy([0, document.getElementById('panel').offsetHeight / 2], { animate: false });
  document.querySelector('#view-detail .detail-back')?.focus({ preventScroll: true });
}

function closeDetail() {
  if (!currentPlaceId) return;
  const id = currentPlaceId;
  currentPlaceId = null;
  rayLayer.clearLayers();
  document.getElementById('view-detail').hidden = true;
  document.getElementById('view-list').hidden = false;
  document.getElementById('panel-scroll').scrollTop = listScroll;
  document.querySelector(`#ranking .place-btn[data-id="${id}"]`)?.focus({ preventScroll: true });
}

function onHash() {
  const m = location.hash.match(/^#plats=(.+)$/);
  if (m && profiles) { showDetail(decodeURIComponent(m[1])); return; }
  closeDetail();
  if (location.hash === '#om') {   // länken "Hjälpmedel" i appbaren
    setSnap(window.matchMedia('(max-width: 899px)').matches ? 'full' : null);
    document.getElementById('om').scrollIntoView({ block: 'start' });
  }
}

function dms(value, pos, neg) {
  const a = Math.abs(value), d = Math.floor(a), m = (a - d) * 60;
  return `${d}°${m.toFixed(3).replace('.', ',')}′ ${value >= 0 ? pos : neg}`;
}

const ICONS = {
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
};

function renderDetail(id) {
  const place = profiles.places.find(p => p.id === id);
  const r = lastRun && lastRun.results.find(x => x.place.id === id);
  const cls = r && r.worst ? r.worst.cls : 'grey';
  const prot = sectors(place, d => d < SHELTERED_M);
  const open = sectors(place, d => d >= EXPOSED_M);
  const facts = [];
  const protCount = place.fetch_m.filter(d => d < SHELTERED_M).length;
  if (prot[0] === 'alla håll') facts.push('Lä från alla håll');
  else if (protCount >= place.fetch_m.length / 2) facts.push(`Lä från alla håll utom ${joinList(sectors(place, d => d >= SHELTERED_M))}`);
  else if (prot.length) facts.push(`Lä från ${joinList(prot)}`);
  if (open.length && open[0] !== 'alla håll') facts.push(`Öppet mot ${joinList(open)} (${km(Math.max(...place.fetch_m) / 1000)})`);
  if (place.ferry_m != null && place.ferry_m < FERRY_SOME_M) facts.push({ warn: true, text: `Linjetrafik ${Math.round(place.ferry_m / 50) * 50} m bort` });
  if (place.dist != null) facts.push(`${km(place.dist)} fågelvägen`);
  const pos = `${dms(place.lat, 'N', 'S')}, ${dms(place.lon, 'E', 'W')}`;
  const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
  const routeUrl = isApple
    ? `https://maps.apple.com/?ll=${place.lat},${place.lon}&q=${encodeURIComponent(place.name)}`
    : `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lon}`;

  const el = document.getElementById('view-detail');
  el.innerHTML = `
    <button type="button" class="detail-back" aria-label="Tillbaka till alla platser">‹ Alla platser</button>
    <div class="detail-head">
      <h2 class="detail-title">${esc(place.name)}</h2>
      <button type="button" class="fav-btn" aria-pressed="${favs.has(id)}" data-act="fav">${favs.has(id) ? '★ Sparad' : '☆ Spara'}</button>
    </div>
    <p class="detail-sub">${statusBadge(cls)} <span>${esc(place.kind)} · ${fmtWhen.format(stay.arrive)} → ${fmtWhen.format(stay.depart)}</span></p>
    <ul class="facts">${facts.map(f => typeof f === 'string' ? `<li>${esc(f)}</li>` : `<li class="warn">${esc(f.text)}</li>`).join('')}</ul>
    <p class="detail-summary">${esc(r ? (r.error || describe(place, r.hours, r.worst)) : describe(place, [], null))}</p>
    <div class="actions">
      <a class="action" href="${routeUrl}" target="_blank" rel="noopener">${ICONS.route}Vägbeskrivning</a>
      <button type="button" class="action" data-act="share">${ICONS.share}Dela</button>
      <button type="button" class="action" data-act="copy">${ICONS.copy}Kopiera position</button>
    </div>
    <p class="copied" role="status"></p>
    <h3 class="section-title">Timme för timme</h3>
    ${r && r.hours.length ? hoursChart(r.hours) : '<p class="empty-state">Ingen prognos för den tiden.</p>'}
    ${r && r.hours.length ? `<details class="more"><summary>Visa som tabell</summary>${hoursTable(r.hours)}</details>` : ''}
    <h3 class="section-title">Skydd per riktning</h3>
    ${roseSvg(place, r ? r.hours : [])}
    <p class="why" style="margin-top:10px">Position ${pos}. Kontrollera alltid djup och botten i sjökortet.</p>`;
  el.querySelector('.detail-back').addEventListener('click', () => {
    if (history.length > 1 && location.hash.startsWith('#plats=')) history.back();
    else { history.replaceState(null, '', location.pathname + location.search); closeDetail(); }
  });
  el.querySelector('[data-act="fav"]').addEventListener('click', () => {
    toggleFav(id);
    el.querySelector('[data-act="fav"]')?.focus();
  });
  const note = el.querySelector('.copied');
  el.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pos); note.textContent = `Kopierat: ${pos}`; }
    catch { note.textContent = pos; }
  });
  el.querySelector('[data-act="share"]').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#plats=${encodeURIComponent(id)}`;
    const text = `${place.name}: ${STATUS_LABEL[cls].toLowerCase()} ${fmtWhen.format(stay.arrive)}–${fmtWhen.format(stay.depart)} enligt Ankarlugn.`;
    try {
      if (navigator.share) await navigator.share({ title: place.name, text, url });
      else { await navigator.clipboard.writeText(url); note.textContent = 'Länken är kopierad.'; }
    } catch { /* användaren avbröt */ }
  });
}

// Diagram: en stapel per timme för beräknad sjö, färgad efter klass, med vindpil och byvind ovanför.
function hoursChart(hours) {
  const step = hours.length > 36 ? 3 : hours.length > 18 ? 2 : 1;
  const cols = hours.filter((_, i) => i % step === 0);
  const W = 30, H = 150, top = 46, base = 128, b = boat();
  const maxHs = Math.max(b.waveR * 1.25, ...cols.map(h => h.hs));
  const y = v => base - (v / maxHs) * (base - top);
  const width = cols.length * W + 8;
  const parts = [`<svg class="hours-svg" width="${width}" viewBox="0 0 ${width} ${H}" role="img" aria-label="Beräknad sjö och vind timme för timme">`];
  parts.push(`<line class="thr" x1="0" x2="${width}" y1="${y(b.waveY)}" y2="${y(b.waveY)}"/><line class="thr" x1="0" x2="${width}" y1="${y(b.waveR)}" y2="${y(b.waveR)}"/>`);
  cols.forEach((h, i) => {
    const x = 4 + i * W, cx = x + W / 2;
    const hh = Math.max(2, base - y(h.hs));
    const tip = `${fmtWhen.format(h.t)}: ${compass(h.dir)} ${Math.round(h.wind)} m/s, byar ${Math.round(h.gust)} m/s, ca ${h.hs.toFixed(2).replace('.', ',')} m sjö`;
    parts.push(`<g class="col"><title>${esc(tip)}</title><rect class="hit" x="${x}" y="0" width="${W}" height="${H}" fill="transparent"/>`
      + `<g transform="translate(${cx} 14) rotate(${h.dir + 180})"><path class="arrow" d="M0 7V-7M-4 -3L0 -7L4 -3"/></g>`
      + `<text x="${cx}" y="36" text-anchor="middle" class="hlabel">${Math.round(h.gust)}</text>`
      + `<rect class="bar ${h.cls}" x="${x + 6}" y="${base - hh}" width="${W - 12}" height="${hh}" rx="3"/>`
      + `<text x="${cx}" y="${H - 6}" text-anchor="middle">${fmtClock.format(h.t)}</text></g>`);
  });
  parts.push('</svg>');
  return `<div class="hours-wrap">${parts.join('')}</div><p class="why">Pil: vart vinden blåser. Siffra: byvind (m/s). Stapel: beräknad sjö; streckade linjer är gränserna för gult och rött för din båtstorlek.</p>`;
}

function hoursTable(hours) {
  return `<table class="hours-table"><thead><tr><th>Tid</th><th>Vind</th><th>Byar</th><th>Sjö</th><th>Bedömning</th></tr></thead><tbody>${
    hours.map(h => `<tr><td>${fmtWhen.format(h.t)}</td><td>${compass(h.dir)} ${Math.round(h.wind)} m/s</td><td>${Math.round(h.gust)} m/s</td><td>${h.hs.toFixed(2).replace('.', ',')} m</td><td>${STATUS_LABEL[h.cls]}</td></tr>`).join('')
  }</tbody></table>`;
}

// --- Dragbart blad på mobil ---
function setSnap(snap) {
  const panel = document.getElementById('panel');
  if (!snap) return;
  panel.dataset.snap = snap;
  panel.style.height = '';
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--sheet-h', `${panel.offsetHeight}px`);
    map.invalidateSize();
  });
}

function initSheet() {
  const panel = document.getElementById('panel');
  const handle = panel.querySelector('.sheet-handle');
  const order = ['peek', 'half', 'full'];
  let startY = 0, startH = 0, moved = false;
  handle.addEventListener('pointerdown', e => {
    startY = e.clientY; startH = panel.offsetHeight; moved = false;
    panel.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!panel.classList.contains('dragging')) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    const max = panel.parentElement.clientHeight - 8;
    panel.style.height = `${Math.min(max, Math.max(120, startH + dy))}px`;
  });
  handle.addEventListener('pointerup', () => {
    panel.classList.remove('dragging');
    const total = panel.parentElement.clientHeight;
    if (!moved) {   // tryck: växla till nästa läge
      setSnap(order[(order.indexOf(panel.dataset.snap) + 1) % order.length]);
      return;
    }
    const frac = panel.offsetHeight / total;
    setSnap(frac < 0.33 ? 'peek' : frac < 0.75 ? 'half' : 'full');
  });
  handle.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSnap(order[(order.indexOf(panel.dataset.snap) + 1) % order.length]); }
  });
  setSnap(panel.dataset.snap);
}

// Visar när prognosen gjordes, och varnar tydligt om den är gammal eller om täckning saknas.
function showForecastAge(results) {
  const created = results.map(r => r.created).filter(Boolean);
  const el = document.getElementById('forecast-age');
  if (!created.length) { el.hidden = true; return; }
  const oldest = new Date(Math.min(...created));
  const stale = Date.now() - oldest > STALE_FORECAST_MS;
  const offline = navigator.onLine === false;
  el.hidden = false;
  el.classList.toggle('stale', stale || offline);
  el.textContent = offline
    ? `Ingen täckning: visar sparad prognos från ${fmtWhen.format(oldest)}.`
    : stale
      ? `Prognosen är från ${fmtWhen.format(oldest)} och kan vara inaktuell.`
      : `SMHI-prognos från ${fmtWhen.format(oldest)}.`;
}

const ME_ICON = L.divIcon({ className: 'me-icon', html: '<span class="me-pulse"></span><span class="me-dot"></span>', iconSize: [22, 22] });
let accuracyCircle = null, watchId = null, renderedPos = null, locateControl = null;

// Ritar den blå pricken (och noggrannhetscirkeln) där du är.
function showMe(pos) {
  myPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  const ll = [myPos.lat, myPos.lon];
  const acc = pos.coords.accuracy || 0;
  if (!myMarker) {
    accuracyCircle = L.circle(ll, { radius: acc, color: '#2a7de1', weight: 1, fillColor: '#2a7de1', fillOpacity: 0.12, interactive: false }).addTo(map);
    myMarker = L.marker(ll, { icon: ME_ICON, zIndexOffset: 1000, keyboard: false }).bindTooltip('Du är här').addTo(map);
  } else {
    myMarker.setLatLng(ll);
    accuracyCircle.setLatLng(ll).setRadius(acc);
  }
  if (!locateControl) locateControl = addLocateControl();
  // Räkna om avstånden bara när du har flyttat dig en bit, så att listan inte hoppar i onödan.
  if (!renderedPos || distanceKm(renderedPos.lat, renderedPos.lon, myPos.lat, myPos.lon) > 0.2) {
    renderedPos = { ...myPos };
    render();
  }
}

function addLocateControl() {
  const Ctl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const a = L.DomUtil.create('a', 'leaflet-bar me-locate');
      a.href = '#';
      a.title = 'Visa var jag är';
      a.setAttribute('role', 'button');
      a.setAttribute('aria-label', 'Visa var jag är');
      a.innerHTML = '<span class="me-dot"></span>';
      L.DomEvent.on(a, 'click', e => {
        L.DomEvent.preventDefault(e);
        if (myPos) map.setView([myPos.lat, myPos.lon], Math.max(map.getZoom(), 13));
      });
      L.DomEvent.disableClickPropagation(a);
      return a;
    },
  });
  return new Ctl().addTo(map);
}

function locate() {
  const btn = document.getElementById('near');
  if (!navigator.geolocation) { setStatus('Webbläsaren kan inte ge din position.'); return; }
  btn.disabled = true;
  btn.textContent = 'Söker position …';
  navigator.geolocation.getCurrentPosition(pos => {
    btn.disabled = false;
    btn.textContent = 'Uppdatera position';
    document.getElementById('radius-label').hidden = false;
    renderedPos = null;
    showMe(pos);
    const radius = Number(document.getElementById('radius').value) || 20;
    map.fitBounds(L.latLng(myPos.lat, myPos.lon).toBounds(radius * 2000));
    // Fortsätt följa positionen så att pricken flyttar med båten.
    if (watchId == null && navigator.geolocation.watchPosition) {
      watchId = navigator.geolocation.watchPosition(showMe, () => {}, { enableHighAccuracy: true, maximumAge: 30000 });
    }
  }, err => {
    btn.disabled = false;
    btn.textContent = 'Nära mig';
    setStatus(err.code === err.PERMISSION_DENIED
      ? 'Du har inte gett sidan tillgång till din position. Tillåt plats i webbläsaren och försök igen.'
      : 'Kunde inte hitta din position just nu.');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// --- Tidsväljare: snabbval och tidslinje ---
const HOUR = 3.6e6;
const TL_DAYS = 5;
const fmtDay = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const fmtWhen = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ });
let stay = null;

function hourFloor(d) { const x = new Date(d); x.setMinutes(0, 0, 0); return x; }
function dayAt(base, addDays, hour) { const x = new Date(base); x.setDate(x.getDate() + addDays); x.setHours(hour, 0, 0, 0); return x; }
function nextHour() { return hourFloor(new Date(Date.now() + HOUR)); }

const PRESETS = {
  tonight() {
    const now = new Date();
    const a = dayAt(now, 0, 18) > now ? dayAt(now, 0, 18) : nextHour();
    return [a, dayAt(now, 1, 10)];
  },
  tomorrow() { const now = new Date(); return [dayAt(now, 1, 18), dayAt(now, 2, 10)]; },
  weekend() {
    const now = new Date(), dow = now.getDay();   // 0 = söndag
    const inWeekend = dow === 6 || dow === 0 || (dow === 5 && now.getHours() >= 18);
    const a = inWeekend ? nextHour() : dayAt(now, 5 - dow, 18);
    let d = dayAt(a, (7 - a.getDay()) % 7, 15);
    if (d - a < 4 * HOUR) d = new Date(a.getTime() + 6 * HOUR);
    return [a, d];
  },
  short() { const a = nextHour(); return [a, new Date(a.getTime() + 4 * HOUR)]; },
};

function setStay(arrive, depart, preset = null) {
  stay = { arrive, depart };
  document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.preset === preset)));
  updateStayView();
  clearTimeout(evalTimer);
  evaluate(arrive, depart);
}

const DAY_COUNT = 6;
const fmtWeekday = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', timeZone: TZ });
const fmtTime = new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
let evalTimer = null;

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 864e5); }

function dayLabel(d) {
  const diff = daysBetween(new Date(), d);
  return diff === 0 ? 'Idag' : diff === 1 ? 'Imorgon' : fmtWeekday.format(d);
}

function updateStayView() {
  const { arrive, depart } = stay;
  document.getElementById('when-arrive').textContent = fmtWhen.format(arrive);
  document.getElementById('when-depart').textContent = fmtWhen.format(depart);
  document.getElementById('when-len').textContent = `${Math.round((depart - arrive) / HOUR)} h`;
  document.getElementById('arrive-time').textContent = fmtTime.format(arrive);
  document.getElementById('depart-time').textContent = fmtTime.format(depart);
  for (const box of document.querySelectorAll('.day-chips')) {
    const which = box.dataset.which;
    const chosen = startOfDay(stay[which]).getTime();
    box.innerHTML = '';
    const first = startOfDay(new Date());
    for (let i = 0; i < DAY_COUNT; i++) {
      const day = new Date(first); day.setDate(day.getDate() + i);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day-chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(day.getTime() === chosen));
      b.textContent = dayLabel(day);
      // Avfärd kan inte väljas före ankomstdagen.
      if (which === 'depart' && day < startOfDay(stay.arrive)) b.disabled = true;
      b.addEventListener('click', () => changeStay(which, { day }));
      box.appendChild(b);
    }
  }
}

// Ändrar ankomst eller avfärd (dag eller ±timmar) och håller vistelsen giltig.
function changeStay(which, { day = null, step = 0 }) {
  let { arrive, depart } = stay;
  const t = new Date(which === 'arrive' ? arrive : depart);
  if (day) t.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  t.setTime(t.getTime() + step * HOUR);
  const earliest = hourFloor(new Date());
  if (which === 'arrive') {
    arrive = t < earliest ? earliest : t;
    // Kommer man fram efter avfärden flyttas avfärden: på förmiddagen 4 h senare, annars till kl 10 nästa morgon.
    if (depart <= arrive) {
      const h = arrive.getHours();
      if (h >= 4 && h < 12) depart = new Date(arrive.getTime() + 4 * HOUR);
      else {
        depart = dayAt(arrive, 0, 10);
        if (depart - arrive < 3 * HOUR) depart = dayAt(arrive, 1, 10);
      }
    }
  } else {
    depart = t <= arrive ? new Date(arrive.getTime() + HOUR) : t;
  }
  stay = { arrive, depart };
  document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
  updateStayView();
  // Vänta lite så att flera snabba tryck på +/− bara ger en ny bedömning.
  clearTimeout(evalTimer);
  evalTimer = setTimeout(() => evaluate(stay.arrive, stay.depart), 350);
}

async function init() {
  map = L.map('map', { zoomControl: true }).setView([59.42, 18.75], 9);
  const osmAttr = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  // OSM har inga kartbitar i dubbel upplösning. Med detectRetina hämtas en zoomnivå mer detaljerade
  // bitar på skärmar med hög upplösning, så att kustlinjer och text blir skarpa (men texten mindre).
  const sharp = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, detectRetina: true, attribution: osmAttr, className: 'base-tiles',
  }).addTo(map);
  const plain = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr, className: 'base-tiles' });
  const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18, detectRetina: true, attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a>',
  }).addTo(map);
  L.control.layers({ 'Skarp karta': sharp, 'Större text': plain }, { 'Sjömärken': seamarks }, { position: 'topright' }).addTo(map);
  rayLayer = L.layerGroup().addTo(map);

  const [res, cal] = await Promise.all([
    fetch('data/profiles.json'),
    fetch('data/calibration.json').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  profiles = await res.json();
  if (cal && Number.isFinite(cal.wave_factor) && cal.wave_factor > 0) waveFactor = cal.wave_factor;
  for (const p of profiles.places) {
    markers[p.id] = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: COLORS.grey, fillOpacity: 0.95 })
      .bindTooltip(p.name).addTo(map)
      .on('click', () => openPlace(p.id));
  }

  document.querySelectorAll('.stepper button').forEach(b =>
    b.addEventListener('click', () => changeStay(b.dataset.which, { step: Number(b.dataset.step) })));
  document.querySelectorAll('.chip').forEach(chip =>
    chip.addEventListener('click', () => setStay(...PRESETS[chip.dataset.preset](), chip.dataset.preset)));
  document.getElementById('near').addEventListener('click', locate);
  document.getElementById('radius').addEventListener('change', () => {
    render();
    if (!myPos) return;
    const radius = Number(document.getElementById('radius').value);
    if (radius) map.fitBounds(L.latLng(myPos.lat, myPos.lon).toBounds(radius * 2000));
    else map.fitBounds(L.latLngBounds(profiles.places.map(p => [p.lat, p.lon])).extend([myPos.lat, myPos.lon]), { padding: [20, 20] });
  });
  document.getElementById('kind').addEventListener('change', render);
  const search = document.getElementById('search');
  search.addEventListener('input', render);
  search.addEventListener('focus', () => setSnap(window.matchMedia('(max-width: 899px)').matches ? 'full' : null));
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.querySelector('#ranking .place-btn')?.click();
    } else if (e.key === 'Escape') {
      search.value = '';
      render();
    }
  });
  const boatSel = document.getElementById('boat');
  try { if (BOATS[localStorage.getItem('ankarlugn-boat')]) boatSel.value = localStorage.getItem('ankarlugn-boat'); } catch {}
  boatSel.addEventListener('change', () => {
    try { localStorage.setItem('ankarlugn-boat', boatSel.value); } catch {}
    if (stay) evaluate(stay.arrive, stay.depart);
  });
  // Har du redan gett sidan tillgång till din position visas den blå pricken direkt.
  if (navigator.permissions && navigator.geolocation) {
    navigator.permissions.query({ name: 'geolocation' })
      .then(st => { if (st.state === 'granted') locate(); })
      .catch(() => {});
  }
  initSheet();
  document.getElementById('best-when').addEventListener('click', () => {
    setSnap(window.matchMedia('(max-width: 899px)').matches ? 'full' : null);
    document.querySelector('.when').scrollIntoView({ block: 'start' });
  });
  window.addEventListener('hashchange', onHash);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && currentPlaceId) history.back(); });
  setStay(...PRESETS.tonight(), 'tonight');
  onHash();   // en delad länk (#plats=...) öppnar platsen direkt
  window.addEventListener('online', () => { forecastCache.clear(); if (stay) evaluate(stay.arrive, stay.depart); });
  window.addEventListener('offline', () => { if (lastRun) showForecastAge(lastRun.results); });
}

init().catch(e => setStatus(`Något gick fel: ${e.message}`));

// Gör sidan användbar utan täckning (se sw.js).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
