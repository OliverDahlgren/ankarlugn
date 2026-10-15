'use strict';

// Ritar kontrollen mot vågbojen (data/validation.json): ett spridningsdiagram per vindstation,
// uppmätt våghöjd mot modellens, med 1:1-linje och sidans gränser för gult och rött.
const NS = 'http://www.w3.org/2000/svg';
const fmt = (x, d = 2) => x.toFixed(d).replace('.', ',');
const pct = x => `${Math.round(x * 100)} %`;
const CLASS_NAMES = ['grön', 'gul', 'röd'];

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function scatter(container, station, maxV, thresholds) {
  const W = 320, H = 300, m = { l: 44, r: 12, t: 12, b: 40 };
  const x = v => m.l + (v / maxV) * (W - m.l - m.r);
  const y = v => H - m.b - (v / maxV) * (H - m.t - m.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'val-svg', role: 'img',
    'aria-label': `Uppmätt mot beräknad våghöjd, vind från ${station.name}` }, container);

  for (let v = 0; v <= maxV + 1e-9; v += 0.2) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'val-grid' }, svg);
    el('text', { x: m.l - 6, y: y(v) + 4, class: 'val-tick', 'text-anchor': 'end' }, svg).textContent = fmt(v, 1);
    el('text', { x: x(v), y: H - m.b + 16, class: 'val-tick', 'text-anchor': 'middle' }, svg).textContent = fmt(v, 1);
  }
  thresholds.forEach((t, i) => {
    el('line', { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, class: 'val-thr' }, svg);
    el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'val-thr' }, svg);
    el('text', { x: x(t) + 3, y: m.t + 10, class: 'val-note' }, svg).textContent = i === 0 ? 'gul' : 'röd';
  });
  el('line', { x1: x(0), y1: y(0), x2: x(maxV), y2: y(maxV), class: 'val-diag' }, svg);
  el('text', { x: x(maxV) - 4, y: y(maxV) + 14, class: 'val-note', 'text-anchor': 'end' }, svg).textContent = 'perfekt';
  el('text', { x: (m.l + W - m.r) / 2, y: H - 4, class: 'val-axis', 'text-anchor': 'middle' }, svg).textContent = 'Uppmätt våghöjd (m)';
  el('text', { x: 12, y: (m.t + H - m.b) / 2, class: 'val-axis', 'text-anchor': 'middle',
    transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})` }, svg).textContent = 'Beräknad (m)';

  const dots = el('g', {}, svg);
  const pts = station.points.map(([t, o, p, u, d]) => ({ t, o, p, u, d, cx: x(Math.min(o, maxV)), cy: y(Math.min(p, maxV)) }));
  for (const pt of pts) el('circle', { cx: pt.cx, cy: pt.cy, r: 4, class: 'val-dot' }, dots);

  // Närmaste punkt visas i en tooltip, så att pekaren inte behöver träffa en liten prick.
  const hi = el('circle', { r: 6, class: 'val-hi', visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'val-tip';
  tip.hidden = true;
  container.appendChild(tip);
  svg.addEventListener('pointermove', ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width), py = (ev.clientY - r.top) * (H / r.height);
    let best = null, bd = Infinity;
    for (const pt of pts) {
      const d = (pt.cx - px) ** 2 + (pt.cy - py) ** 2;
      if (d < bd) { bd = d; best = pt; }
    }
    if (!best || bd > 900) { tip.hidden = true; hi.setAttribute('visibility', 'hidden'); return; }
    hi.setAttribute('cx', best.cx); hi.setAttribute('cy', best.cy); hi.setAttribute('visibility', 'visible');
    tip.textContent = `${best.t.replace('T', ' ')}:00 UTC · uppmätt ${fmt(best.o)} m · beräknad ${fmt(best.p)} m · vind ${fmt(best.u, 1)} m/s från ${best.d}°`;
    tip.hidden = false;
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; hi.setAttribute('visibility', 'hidden'); });
}

function statsTable(stations) {
  const rows = [
    ['Antal timmar', s => String(s.n)],
    ['Medelvärde uppmätt / beräknat', s => `${fmt(s.mean_obs_m)} / ${fmt(s.mean_pred_m)} m`],
    ['Systematiskt fel (beräknat − uppmätt)', s => `${s.bias_m > 0 ? '+' : ''}${fmt(s.bias_m)} m`],
    ['Typiskt fel (RMSE)', s => `${fmt(s.rmse_m)} m`],
    ['Samvariation (r)', s => s.r == null ? '–' : fmt(s.r)],
    ['Rätt färg (grön/gul/röd)', s => pct(s.class_agreement)],
    ['… att alltid svara grönt skulle ge', s => pct(s.baseline_always_green)],
    ['Gula/röda timmar som fångades', s => s.rough_caught == null ? '–' : `${pct(s.rough_caught)} av ${s.rough_hours}`],
    ['Lugna timmar som felaktigt varnades', s => s.calm_false_alarm == null ? '–' : pct(s.calm_false_alarm)],
    ['Lugnare färg än verkligheten', s => pct(s.class_underestimated)],
  ];
  const t = document.createElement('table');
  t.className = 'val-table';
  const head = t.createTHead().insertRow();
  head.appendChild(document.createElement('th'));
  for (const st of stations) {
    const th = document.createElement('th');
    th.textContent = `Vind från ${st.name}`;
    head.appendChild(th);
  }
  const body = t.createTBody();
  for (const [label, f] of rows) {
    const tr = body.insertRow();
    const th = document.createElement('th');
    th.textContent = label;
    tr.appendChild(th);
    for (const st of stations) tr.insertCell().textContent = f(st.stats);
  }
  return t;
}

function confusionTable(st) {
  const t = document.createElement('table');
  t.className = 'val-table';
  const cap = t.createCaption();
  cap.textContent = `Färger, vind från ${st.name} (rader: uppmätt, kolumner: beräknat)`;
  const head = t.createTHead().insertRow();
  head.appendChild(document.createElement('th'));
  for (const c of CLASS_NAMES) { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); }
  const body = t.createTBody();
  st.stats.confusion_obs_rows_pred_cols.forEach((row, i) => {
    const tr = body.insertRow();
    const th = document.createElement('th');
    th.textContent = CLASS_NAMES[i];
    tr.appendChild(th);
    for (const v of row) tr.insertCell().textContent = String(v);
  });
  return t;
}

fetch('data/validation.json').then(r => r.json()).then(v => {
  const root = document.getElementById('validation');
  const maxV = Math.max(0.6, Math.ceil(Math.max(...v.stations.flatMap(s => s.points.map(p => Math.max(p[1], p[2])))) * 5) / 5);
  const grid = document.createElement('div');
  grid.className = 'val-grid-wrap';
  root.appendChild(grid);
  for (const st of v.stations) {
    const fig = document.createElement('figure');
    fig.className = 'val-fig';
    const cap = document.createElement('figcaption');
    cap.textContent = `Vind från ${st.name}`;
    fig.appendChild(cap);
    grid.appendChild(fig);
    scatter(fig, st, maxV, v.thresholds_m);
  }
  root.appendChild(statsTable(v.stations));
  for (const st of v.stations) root.appendChild(confusionTable(st));
}).catch(() => {
  document.getElementById('validation').textContent = 'Kontrollen kunde inte laddas.';
});

// Kalibreringen (data/calibration.json): beslut, faktor per vindkälla och prövning per block.
function cell(tr, text, tag = 'td') {
  const c = document.createElement(tag);
  c.textContent = text;
  tr.appendChild(c);
}

fetch('data/calibration.json').then(r => r.json()).then(c => {
  const root = document.getElementById('calibration');
  const decision = document.createElement('p');
  decision.className = 'cal-decision';
  decision.textContent = `Resultat: ${c.decision} Sidan använder faktorn ×${fmt(c.wave_factor)}.`;
  root.appendChild(decision);

  const names = Object.keys(c.sources);
  const t = document.createElement('table');
  t.className = 'val-table';
  const head = t.createTHead().insertRow();
  cell(head, '', 'th');
  for (const n of names) cell(head, `Vind från ${n}`, 'th');
  const body = t.createTBody();
  const rows = [
    ['Faktor (vikt 3:1)', a => `×${fmt(a.k)} (90 %: ${fmt(a.k_90[0])}–${fmt(a.k_90[1])})`],
    ['Faktor med vikt 1:1 / 5:1', a => `×${fmt(a.k_by_weight['1'])} / ×${fmt(a.k_by_weight['5'])}`],
    ['Faktor med minsta kvadratmetoden', a => `×${fmt(a.k_least_squares)} (90 %: ${fmt(a.k_least_squares_90[0])}–${fmt(a.k_least_squares_90[1])})`],
    ['Slår ”ingen korrektion” i', a => `${a.folds_better} av ${a.folds.length} block`],
    ['Missade grova timmar, utan / med faktor', a => `${a.full_period.miss_1} / ${a.full_period.miss_k}`],
    ['Onödiga varningar, utan / med faktor', a => `${a.full_period.false_alarm_1} / ${a.full_period.false_alarm_k}`],
  ];
  for (const [label, f] of rows) {
    const tr = body.insertRow();
    cell(tr, label, 'th');
    for (const n of names) cell(tr, f(c.sources[n]));
  }
  root.appendChild(t);

  for (const n of names) {
    const ft = document.createElement('table');
    ft.className = 'val-table';
    ft.createCaption().textContent = `Prövning på osedda block, vind från ${n}`;
    const h = ft.createTHead().insertRow();
    for (const x of ['Testblock', 'Faktor från övriga block', 'Missade (utan / med)', 'Onödiga varningar (utan / med)', 'Bättre?']) cell(h, x, 'th');
    const b = ft.createTBody();
    for (const f of c.sources[n].folds) {
      const tr = b.insertRow();
      cell(tr, `${f.days[0].slice(5)} – ${f.days[1].slice(5)}`);
      cell(tr, `×${fmt(f.k_train)}`);
      cell(tr, `${f.miss_1} / ${f.miss_k}`);
      cell(tr, `${f.false_alarm_1} / ${f.false_alarm_k}`);
      cell(tr, f.cost_k < f.cost_1 ? 'ja' : 'nej');
    }
    root.appendChild(ft);
  }

  const note = document.createElement('p');
  note.textContent = 'Slutsats: Vindkällorna drar åt olika håll, och deras intervall överlappar inte. Skillnaden beror alltså mest '
    + 'på vilken vind modellen får, inte på vågformeln. Med vind från närmaste station (Berga) stämmer formeln i genomsnitt '
    + '(minsta kvadrat nära ×1). För att kalibrera på riktigt behövs SMHI:s egen prognosvind jämförd med mätningar under '
    + 'längre tid. Tills dess används ingen korrektion.';
  if (c.wave_factor === 1) root.appendChild(note);
}).catch(() => {
  document.getElementById('calibration').textContent = 'Kalibreringen kunde inte laddas.';
});
