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

async function loadForecast(place) {
  // SMHI:s rutnät är 2,5 km, så avrunda för att återanvända svar för närliggande platser.
  const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  if (!forecastCache.has(key)) {
    forecastCache.set(key, fetch(SMHI_URL(place.lat, place.lon)).then(r => {
      if (!r.ok) throw new Error(`SMHI svarade ${r.status}`);
      return r.json();
    }).then(j => j.timeSeries.map(s => ({
      t: new Date(s.time),
      dir: s.data.wind_from_direction,
      wind: s.data.wind_speed,
      gust: s.data.wind_speed_of_gust ?? s.data.wind_speed,
    })).filter(s => s.dir != null && s.wind != null)));
  }
  return forecastCache.get(key);
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
  return `<div class="timeline" title="Varje ruta är en timme">${hours.map(h =>
    `<span class="${h.cls}" title="${fmtHour.format(h.t)}: ${compass(h.dir)} ${Math.round(h.wind)} (${Math.round(h.gust)}) m/s"></span>`).join('')}</div>`;
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
  const results = await Promise.all(profiles.places.map(async place => {
    try {
      const series = await loadForecast(place);
      const hours = hoursInStay(series, arrive, depart).map(h => rateHour(place, h));
      if (!hours.length) return { place, hours, worst: null, error: 'Ingen prognos för den tiden' };
      const worst = hours.reduce((a, b) =>
        LEVEL[b.cls] > LEVEL[a.cls] || (LEVEL[b.cls] === LEVEL[a.cls] && b.hs > a.hs) ? b : a);
      const lastForecast = series[series.length - 1].t;
      return { place, hours, worst, truncated: depart > lastForecast, lastForecast };
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
  updateTimelineWind();
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

function render() {
  if (!lastRun) return;
  const { results, arrive, depart } = lastRun;
  for (const r of results) {
    r.place.dist = myPos ? distanceKm(myPos.lat, myPos.lon, r.place.lat, r.place.lon) : null;
  }
  const shown = results.filter(r => matchesFilters(r.place));
  const list = document.getElementById('ranking');
  list.innerHTML = '';
  for (const r of results) {
    const cls = r.worst ? r.worst.cls : 'grey';
    const why = r.error ? r.error : describe(r.place, r.hours, r.worst);
    const dist = r.place.dist != null ? ` · ${r.place.dist.toFixed(1).replace('.', ',')} km` : '';
    const visible = shown.includes(r);
    const m = markers[r.place.id];
    m.setStyle({ fillColor: COLORS[cls], fillOpacity: visible ? 0.95 : 0.15, opacity: visible ? 1 : 0.3 });
    m.bindPopup(`<strong>${r.place.name}</strong> <span class="dot ${cls}"></span><br><span class="why">${r.place.kind}${dist}. ${why}</span>
      ${r.hours.length ? timeline(r.hours) : ''}${roseSvg(r.place, r.hours)}`, { maxWidth: 300 });
    if (!visible) continue;

    const li = document.createElement('li');
    const swell = r.place.ferry_m != null && r.place.ferry_m < FERRY_NEAR_M ? ' <span class="badge" title="Linjetrafik nära">svall</span>' : '';
    li.innerHTML = `<span class="name">${r.place.name}</span> <span class="dot ${cls}"></span>${swell}<br>
      <span class="why">${r.place.kind}${dist}. ${why}</span>${r.hours.length ? timeline(r.hours) : ''}`;
    li.addEventListener('click', () => { map.setView([r.place.lat, r.place.lon], 13); m.openPopup(); });
    list.appendChild(li);
  }
  if (!shown.length) list.innerHTML = '<li class="why">Inga platser matchar filtret. Öka avståndet eller visa alla typer.</li>';

  const truncated = results.find(r => r.truncated);
  const failed = results.filter(r => r.error).length;
  setStatus([
    `${shown.length} av ${results.length} platser visas, bedömda för ${fmtHour.format(arrive)} – ${fmtHour.format(depart)}.`,
    myPos ? 'Avstånd räknas fågelvägen, inte sjövägen.' : '',
    truncated ? `Prognosen räcker bara till ${fmtHour.format(truncated.lastForecast)}; senare timmar ingår inte.` : '',
    failed ? `${failed} platser saknar prognos.` : '',
  ].filter(Boolean).join(' '));
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
    if (profiles) updateTimelineWind();
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
const REF_PLACE_ID = 'n3053781982';   // Sandhamn: referens för vinden i tidslinjen
let stay = null, pickingDepart = false;

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
  pickingDepart = false;
  document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.preset === preset)));
  updateStayView();
  scrollTimelineTo(arrive);
  evaluate(arrive, depart);
}

function updateStayView() {
  const { arrive, depart } = stay;
  document.getElementById('when-arrive').textContent = fmtWhen.format(arrive);
  document.getElementById('when-depart').textContent = pickingDepart ? 'välj avfärd' : fmtWhen.format(depart);
  document.getElementById('when-len').textContent = pickingDepart ? '' : `${Math.round((depart - arrive) / HOUR)} h`;
  document.getElementById('tl-hint').textContent = pickingDepart
    ? 'Tryck nu på när du lämnar.'
    : 'Eller tryck på din ankomsttid i tidslinjen och sedan på avfärden.';
  for (const cell of document.querySelectorAll('.tl-cell')) {
    const t = Number(cell.dataset.t);
    const end = pickingDepart ? arrive.getTime() : depart.getTime();
    cell.classList.toggle('in-range', t >= arrive.getTime() && t < end);
    cell.classList.toggle('is-start', t === arrive.getTime());
    cell.classList.toggle('is-end', !pickingDepart && t === depart.getTime() - HOUR);
    cell.setAttribute('aria-pressed', String(t >= arrive.getTime() && t < end));
  }
}

function buildTimeline() {
  const tl = document.getElementById('timeline');
  tl.innerHTML = '';
  const start = hourFloor(new Date());
  const end = dayAt(start, TL_DAYS, 0);
  let dayEl = null, hoursEl = null, dayKey = '';
  for (let t = start; t < end; t = new Date(t.getTime() + HOUR)) {
    const key = fmtDay.format(t);
    if (key !== dayKey) {
      dayKey = key;
      dayEl = document.createElement('div');
      dayEl.className = 'tl-day';
      dayEl.innerHTML = `<div class="tl-day-label">${key}</div>`;
      hoursEl = document.createElement('div');
      hoursEl.className = 'tl-hours';
      dayEl.appendChild(hoursEl);
      tl.appendChild(dayEl);
    }
    const h = Number(fmtClock.format(t));
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'tl-cell' + (h >= 21 || h < 6 ? ' night' : '');
    cell.dataset.t = String(t.getTime());
    cell.setAttribute('aria-label', `${key} klockan ${h}`);
    cell.innerHTML = `<span class="tl-h">${String(h).padStart(2, '0')}</span><span class="tl-w"></span><span class="tl-bar"></span>`;
    cell.addEventListener('click', () => pickHour(new Date(t)));
    hoursEl.appendChild(cell);
  }
}

function pickHour(t) {
  if (!pickingDepart) {
    stay = { arrive: t, depart: new Date(t.getTime() + HOUR) };
    pickingDepart = true;
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    updateStayView();
    return;
  }
  if (t < stay.arrive) {   // tryckte före ankomsten: börja om därifrån
    stay = { arrive: t, depart: new Date(t.getTime() + HOUR) };
    updateStayView();
    return;
  }
  setStay(stay.arrive, new Date(t.getTime() + HOUR));
}

function scrollTimelineTo(t) {
  const cell = document.querySelector(`.tl-cell[data-t="${hourFloor(t).getTime()}"]`);
  const tl = document.getElementById('timeline');
  if (!cell) return;
  const left = tl.scrollLeft + cell.getBoundingClientRect().left - tl.getBoundingClientRect().left - tl.clientWidth / 4;
  tl.scrollLeft = Math.max(0, left);
}

// Vindprognosen i tidslinjen, från närmaste plats (eller Sandhamn innan positionen är känd).
async function updateTimelineWind() {
  let ref = profiles.places.find(p => p.id === REF_PLACE_ID) || profiles.places[0];
  if (myPos) {
    ref = profiles.places.reduce((a, b) =>
      distanceKm(myPos.lat, myPos.lon, a.lat, a.lon) <= distanceKm(myPos.lat, myPos.lon, b.lat, b.lon) ? a : b);
  }
  let series;
  try { series = await loadForecast(ref); } catch { return; }
  document.getElementById('tl-ref').textContent = `Byvind vid ${ref.name.split(',')[0]} (m/s)`;
  for (const cell of document.querySelectorAll('.tl-cell')) {
    const t = Number(cell.dataset.t);
    let best = null;
    for (const s of series) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    const w = cell.querySelector('.tl-w');
    if (!best || Math.abs(best.t - t) > 3 * HOUR) { w.textContent = ''; cell.dataset.wind = ''; continue; }
    const g = Math.round(best.gust);
    // Pilen pekar dit vinden blåser.
    w.innerHTML = `<span class="tl-arrow" style="transform: rotate(${best.dir + 180}deg)">↑</span>${g}`;
    w.title = `${compass(best.dir)} ${Math.round(best.wind)} m/s, byar ${g} m/s`;
    cell.dataset.wind = g < 8 ? '1' : g < 14 ? '2' : g < 20 ? '3' : '4';
  }
}

async function init() {
  map = L.map('map', { zoomControl: true }).setView([59.42, 18.75], 9);
  const osmAttr = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  // OSM har inga kartbitar i dubbel upplösning. Med detectRetina hämtas en zoomnivå mer detaljerade
  // bitar på skärmar med hög upplösning, så att kustlinjer och text blir skarpa (men texten mindre).
  const sharp = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, detectRetina: true, attribution: osmAttr,
  }).addTo(map);
  const plain = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr });
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
      .on('popupopen', () => drawRays(p))
      .on('popupclose', () => rayLayer.clearLayers());
  }

  buildTimeline();
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
  setStay(...PRESETS.tonight(), 'tonight');
}

init().catch(e => setStatus(`Något gick fel: ${e.message}`));
