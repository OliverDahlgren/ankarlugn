'use strict';

// --- Inställningar för bedömningen (se method.html) ---
const SMHI_URL = (lat, lon) =>
  `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon.toFixed(4)}/lat/${lat.toFixed(4)}/data.json`;
const SPREAD_DEG = 10;          // vinden antas kunna vrida ±10° kring prognosen
const WAVE_YELLOW = 0.2;        // m signifikant våghöjd: märkbar sjöhävning
const WAVE_RED = 0.4;           // m: obekvämt eller riskabelt att ligga
const GUST_YELLOW = 18;         // m/s byvind: kraftig vind även i lä
const GUST_RED = 24;
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

// Stryklängd i vindens riktning: största värdet inom ±SPREAD_DEG, eftersom vinden pendlar.
function fetchFor(place, dirDeg) {
  const n = place.fetch_m.length;
  const step = 360 / n;
  let worst = 0;
  for (let d = dirDeg - SPREAD_DEG; d <= dirDeg + SPREAD_DEG; d += step / 2) {
    const i = Math.round((((d % 360) + 360) % 360) / step) % n;
    worst = Math.max(worst, place.fetch_m[i]);
  }
  return worst;
}

// Signifikant våghöjd för stryklängdsbegränsad sjö (JONSWAP): Hs = 0.0016 · U · √(F/g).
function waveHeight(windMs, fetchM) {
  return 0.0016 * windMs * Math.sqrt(fetchM / 9.81);
}

function rateHour(place, h) {
  const fetch = fetchFor(place, h.dir);
  const hs = waveHeight(h.wind, fetch);
  let cls = hs >= WAVE_RED ? 'red' : hs >= WAVE_YELLOW ? 'yellow' : 'green';
  if (h.gust >= GUST_RED) cls = 'red';
  else if (h.gust >= GUST_YELLOW && cls === 'green') cls = 'yellow';
  // Helt öppet mot havet: dyning kan komma in även i måttlig vind.
  if (fetch >= profiles.max_fetch_m && h.wind >= 6 && cls === 'green') cls = 'yellow';
  return { ...h, fetch, hs, cls };
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

  if (!hours.length) return parts.join(' ');
  if (worst.cls === 'green') {
    const dirs = [...new Set(hours.map(h => compass(h.dir)))];
    parts.push(`Prognosens vind (${dirs.slice(0, 4).join(', ')}) kommer från skyddade håll hela vistelsen.`);
  } else {
    const first = hours.find(h => h.cls === worst.cls);
    const atStart = first === hours[0];
    const when = atStart ? 'redan vid ankomst' : `från ${fmtHour.format(first.t)}`;
    const reason = first.hs >= WAVE_YELLOW
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

async function evaluate(arrive, depart) {
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
    li.innerHTML = `<span class="name">${r.place.name}</span> <span class="dot ${cls}"></span><br>
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

function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

async function init() {
  map = L.map('map', { zoomControl: true }).setView([59.42, 18.75], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a>',
  }).addTo(map);
  rayLayer = L.layerGroup().addTo(map);

  const res = await fetch('data/profiles.json');
  profiles = await res.json();
  for (const p of profiles.places) {
    markers[p.id] = L.circleMarker([p.lat, p.lon], { radius: 8, color: '#fff', weight: 2, fillColor: COLORS.grey, fillOpacity: 0.95 })
      .bindTooltip(p.name).addTo(map)
      .on('popupopen', () => drawRays(p))
      .on('popupclose', () => rayLayer.clearLayers());
  }

  const now = new Date();
  const arrive = new Date(now); arrive.setMinutes(0, 0, 0); arrive.setHours(arrive.getHours() + 1);
  const depart = new Date(arrive); depart.setDate(depart.getDate() + 1); depart.setHours(10);
  if (depart - arrive < 6 * 3.6e6) depart.setDate(depart.getDate() + 1);
  document.getElementById('arrive').value = toLocalInput(arrive);
  document.getElementById('depart').value = toLocalInput(depart);

  document.getElementById('stay').addEventListener('submit', e => {
    e.preventDefault();
    const a = new Date(document.getElementById('arrive').value);
    const d = new Date(document.getElementById('depart').value);
    if (!(d > a)) { setStatus('Avfärden måste vara efter ankomsten.'); return; }
    evaluate(a, d);
  });
  document.getElementById('near').addEventListener('click', locate);
  document.getElementById('radius').addEventListener('change', () => {
    render();
    if (!myPos) return;
    const radius = Number(document.getElementById('radius').value);
    if (radius) map.fitBounds(L.latLng(myPos.lat, myPos.lon).toBounds(radius * 2000));
    else map.fitBounds(L.latLngBounds(profiles.places.map(p => [p.lat, p.lon])).extend([myPos.lat, myPos.lon]), { padding: [20, 20] });
  });
  document.getElementById('kind').addEventListener('change', render);
  evaluate(arrive, depart);
}

init().catch(e => setStatus(`Något gick fel: ${e.message}`));
