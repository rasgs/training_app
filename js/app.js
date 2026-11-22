// UI: rendering + event handling. Plain ES modules, no build step.
import * as S from './store.js';
import { GROUPS, EQUIPMENT, TEMPOS } from './data.js';

const { state } = S;

const ui = {
  tab: 'workout',
  bandMenu: null,      // exId whose band dropdown is open
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  calDay: null,        // 'YYYY-MM-DD' selected in the calendar
  calGroups: new Set(), // calendar muscle-group filter (empty = all)
  prGroups: new Set(),  // PR view muscle-group filter
  prOpen: new Set(),    // exercises expanded in the PR overview
  pickerQuery: '',      // add-exercise search text
  pickerCollapsed: new Set(), // collapsed groups in the add-exercise sheet
  drafts: {},          // exId -> { level, bands[], bandMode, value, addedKg } for the active session
  sheet: null,         // { type, id }
  timer: null,         // hold timer state
  rest: null,          // { end, done }
  openSessions: new Set(),
  showArchived: false,
  settingsTab: 'skills', // skills | bands | data
};

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const unit = (ex) => (ex.kind === 'static' ? 's' : 'reps');
const fmtVal = (ex, v) => (ex.kind === 'static' ? `${v}s` : `${v}`);
const fmtClock = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};
const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDur = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

function swatch(b, extra = '') {
  const h = 4 + (clamp(Number(b.widthMm) || 0, 0, 80) / 80) * 16;
  return `<span class="band-swatch ${extra}" style="--c:${esc(b.color)};--h:${h.toFixed(1)}px" title="${esc(b.name)} · ${esc(b.widthMm)} mm"></span>`;
}

/** Compact description of the bands/load used on a set. */
function loadInline(set) {
  const bands = set.bands.map(S.bandById).filter(Boolean);
  const parts = [];
  if (bands.length) {
    parts.push(`<span class="band-inline">${bands.map((b) => swatch(b)).join('')}</span>
      <span class="small muted">${set.bandMode === 'assist' ? 'assist' : 'resist'}</span>`);
  }
  if (set.addedKg) parts.push(`<span class="small muted">+${esc(set.addedKg)} kg</span>`);
  if (!parts.length) parts.push('<span class="small muted">clean</span>');
  return parts.join(' ');
}

const tempoTag = (set) => (set.tempo && TEMPOS[set.tempo]
  ? `<span class="badge tempo">${TEMPOS[set.tempo]}</span>` : '');

const equipBadge = (ex) => (ex.equipment && ex.equipment !== 'none'
  ? `<span class="badge">${ex.equipment === 'rings' ? '◯◯' : '━'} ${EQUIPMENT[ex.equipment]}</span>` : '');

function ladderBar(ex, lvl = ex.currentLevel) {
  return `<div class="ladder" aria-label="Level ${lvl + 1} of ${ex.levels.length}">${ex.levels
    .map((_, i) => `<i class="${i < lvl ? 'done' : i === lvl ? 'cur' : ''}"></i>`).join('')}</div>`;
}

// ---------- audio / wake lock ----------
let audioCtx = null;
function beep(freq = 880, dur = 0.12, times = 1) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const t = audioCtx.currentTime + i * (dur + 0.08);
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    }
  } catch { /* audio not available */ }
  navigator.vibrate?.(times > 1 ? [80, 60, 80] : 60);
}
let wakeLock = null;
async function holdWake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}

// ---------- drafts (what the next logged set will be) ----------
function draftFor(exId) {
  const ex = S.exById(exId);
  if (!ui.drafts[exId]) {
    const s = S.activeSession();
    const inSession = s?.sets.filter((x) => x.exId === exId).at(-1);
    const prev = inSession || S.lastSetsFor(exId, s?.id)?.sets.at(-1);
    ui.drafts[exId] = prev
      ? {
          level: ex.currentLevel,
          // Carry bands over only if they were used at the same level.
          bands: prev.level === ex.currentLevel ? [...prev.bands] : [],
          bandMode: prev.bandMode || 'assist',
          value: prev.value,
          addedKg: prev.level === ex.currentLevel ? prev.addedKg || 0 : 0,
          tempo: prev.tempo || null,
        }
      : { level: ex.currentLevel, bands: [], bandMode: 'assist', value: ex.kind === 'static' ? 10 : 5, addedKg: 0, tempo: null };
  }
  const d = ui.drafts[exId];
  d.level = clamp(d.level, 0, ex.levels.length - 1);
  return d;
}

// ================= VIEWS =================
function render() {
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  const v = { workout: viewWorkout, prs: viewPRs, history: viewHistory, settings: viewSettings }[ui.tab];
  $('#view').innerHTML = v();
  renderSheet();
  updateTopbar();
}

// ---------- Workout ----------
function viewWorkout() {
  const s = S.activeSession();
  if (!s) return viewWorkoutIdle();
  const cards = s.exerciseIds.map(S.exById).filter(Boolean).map((ex) => exCard(ex, s)).join('');
  return `
    ${cards || '<div class="empty">Add the first exercise of today\'s session.</div>'}
    <div class="stack" style="margin-top:14px">
      <button class="btn block big" data-act="open-picker">+ Add exercise</button>
      <button class="btn block ghost" data-act="finish-session">Finish session</button>
    </div>`;
}

function viewWorkoutIdle() {
  const active = state.exercises.filter((e) => !e.archived);
  const ready = active.map((ex) => ({ ex, r: S.readiness(ex) })).filter((x) => x.r.ready);
  const last = [...state.sessions].filter((x) => x.endedAt).sort((a, b) => b.startedAt - a.startedAt)[0];
  return `
    <div class="card hero">
      <p class="big-title">Progress by <em>levels</em>,<br>not kilos.</p>
      <p class="muted small" style="margin:0 0 16px">Log the progression step, the band you used and how long you held it.
      Move up when the goal is clean.</p>
      <button class="btn primary block big" data-act="start-session">Start session</button>
    </div>
    ${ready.length ? `<h2>Ready to level up</h2>${ready.map(({ ex }) => `
      <div class="card tap" data-act="open-ex" data-id="${ex.id}">
        <div class="spread"><h3>${esc(ex.name)}</h3><span class="badge ready">Level up</span></div>
        <div class="small muted" style="margin-top:4px">${esc(ex.levels[ex.currentLevel])} → <b style="color:var(--text)">${esc(ex.levels[ex.currentLevel + 1])}</b></div>
        ${ladderBar(ex)}
      </div>`).join('')}` : ''}
    ${last ? `<h2>Last session</h2>${sessionCard(last, true)}` : ''}`;
}

function exCard(ex, session) {
  const d = draftFor(ex.id);
  const sets = session.sets.filter((x) => x.exId === ex.id);
  const prev = S.lastSetsFor(ex.id, session.id);
  const prIds = new Set(S.prsFor(ex.id).events.map((ev) => ev.entry.id));
  const r = S.readiness(ex);
  const nextIsUp = r.ready && d.level === ex.currentLevel;
  const bandsSorted = [...state.bands].sort((a, b) => (a.widthMm || 0) - (b.widthMm || 0));

  return `
  <div class="card ex-card">
    <div class="ex-head">
      <div>
        <h3>${esc(ex.name)}</h3>
        <div class="row" style="margin-top:4px">
          <span class="badge ${ex.kind === 'static' ? 'kind-static' : ''}">${ex.kind === 'static' ? 'Static hold' : 'Reps'}</span>
          ${equipBadge(ex)}
          <span class="small muted">goal ${fmtVal(ex, ex.goal)} clean</span>
        </div>
      </div>
      <button class="icon-btn plain" data-act="remove-ex" data-id="${ex.id}" aria-label="Remove ${esc(ex.name)} from session">×</button>
    </div>

    <div class="stepper">
      <button data-act="lvl" data-id="${ex.id}" data-d="-1" ${d.level <= 0 ? 'disabled' : ''} aria-label="Easier progression">‹</button>
      <div class="st-mid">
        <div class="st-lvl">Level ${d.level + 1} / ${ex.levels.length}</div>
        <div class="st-name">${esc(ex.levels[d.level])}</div>
      </div>
      <button data-act="lvl" data-id="${ex.id}" data-d="1" ${d.level >= ex.levels.length - 1 ? 'disabled' : ''} aria-label="Harder progression">›</button>
    </div>
    ${ladderBar(ex, d.level)}
    ${nextIsUp ? `<div class="hint"><span class="badge ready">Goal hit ${r.hits}×</span> Try <b style="color:var(--text)">${esc(ex.levels[d.level + 1])}</b>
      <button class="btn sm" data-act="lvl" data-id="${ex.id}" data-d="1">Level up</button></div>` : ''}

    ${ex.allowBands !== false || ex.allowWeight !== false ? `<div class="section">
      ${ex.allowBands !== false ? `<div class="label" style="margin-bottom:6px">Resistance band</div>
      <div class="band-ctl">
        ${bandDropdown(ex, d, bandsSorted)}
        <div class="seg" role="group" aria-label="Band mode">
          <button data-act="mode" data-id="${ex.id}" data-m="assist" aria-pressed="${d.bandMode === 'assist'}">Assist</button>
          <button data-act="mode" data-id="${ex.id}" data-m="resist" aria-pressed="${d.bandMode === 'resist'}">Resist</button>
        </div>
      </div>` : ''}
      ${ex.allowWeight !== false ? `
        <label class="weight-row ${ex.allowBands !== false ? 'below' : ''}">
          <span class="label">Added weight</span>
          <span class="kg-input"><input class="input num" type="number" inputmode="decimal" min="0" step="0.5" value="${esc(d.addedKg || '')}" placeholder="0" data-bind="kg" data-id="${ex.id}"><span class="muted">kg</span></span>
        </label>` : ''}
    </div>` : ''}

    ${ex.kind === 'reps' ? `
      <div class="section">
        <div class="label" style="margin-bottom:6px">Tempo</div>
        <div class="seg seg-full" role="group" aria-label="Tempo">
          <button data-act="tempo" data-id="${ex.id}" data-t="" aria-pressed="${!d.tempo}">Standard</button>
          ${Object.entries(TEMPOS).map(([k, label]) => `
            <button data-act="tempo" data-id="${ex.id}" data-t="${k}" aria-pressed="${d.tempo === k}">${label}</button>`).join('')}
        </div>
      </div>` : ''}

    <div class="section value-row">
      <div class="counter">
        <button data-act="val" data-id="${ex.id}" data-d="-1" aria-label="Decrease">−</button>
        <div>
          <input class="num" type="number" inputmode="numeric" min="0" value="${esc(d.value)}" data-bind="value" data-id="${ex.id}" aria-label="${ex.kind === 'static' ? 'Hold seconds' : 'Reps'}">
          <span class="unit">${ex.kind === 'static' ? 'seconds held' : 'reps'}</span>
        </div>
        <button data-act="val" data-id="${ex.id}" data-d="1" aria-label="Increase">+</button>
      </div>
      ${ex.kind === 'static' ? `<button class="btn hold-btn" data-act="hold" data-id="${ex.id}">▶ Timer</button>` : ''}
    </div>
    <button class="btn primary block big" style="margin-top:10px" data-act="log" data-id="${ex.id}">Log set</button>

    ${sets.length ? `<ul class="sets">${sets.map((x, i) => `
      <li>
        <span class="s-n">${i + 1}</span>
        <span><span class="small">${esc(x.levelName)}</span> ${tempoTag(x)}<br>${loadInline(x)}</span>
        <span class="s-v">${esc(x.value)}<small>${unit(ex)}</small>${prIds.has(x.id) ? '<span class="s-pr">PR</span>' : ''}</span>
        <button class="icon-btn plain" data-act="del-set" data-session="${session.id}" data-set="${x.id}" aria-label="Delete set">×</button>
      </li>`).join('')}</ul>` : ''}

    ${prev ? `<div class="hint"><span class="label">Last time</span> ${lastTimeLine(ex, prev.sets)}</div>` : ''}
  </div>`;
}

/** Compact multi-select dropdown: closed it shows the chosen band(s); open it lists the inventory. */
function bandDropdown(ex, d, bands) {
  const open = ui.bandMenu === ex.id;
  const chosen = d.bands.map(S.bandById).filter(Boolean);
  const label = chosen.length
    ? `<span class="band-inline">${chosen.map((b) => swatch(b)).join('')}</span><span class="dd-text">${chosen.map((b) => esc(b.name)).join(' + ')}</span>`
    : '<span class="dd-text muted">No band</span>';
  return `
    <div class="dd">
      <button class="dd-btn" data-act="band-menu" data-id="${ex.id}" aria-haspopup="listbox" aria-expanded="${open}">
        ${label}<span class="dd-caret">▾</span>
      </button>
      ${open ? `
        <div class="dd-menu" role="listbox" aria-multiselectable="true" aria-label="Bands">
          <button class="dd-item" role="option" data-act="band-clear" data-id="${ex.id}" aria-selected="${chosen.length === 0}">
            <span class="band-swatch" style="--c:transparent;--h:10px"></span><span>No band</span><span class="dd-check">✓</span>
          </button>
          ${bands.map((b) => `
            <button class="dd-item" role="option" data-act="band" data-id="${ex.id}" data-band="${b.id}" aria-selected="${d.bands.includes(b.id)}">
              ${swatch(b)}<span>${esc(b.name)} <span class="mm">${esc(b.widthMm)} mm · ${esc(b.minKg)}–${esc(b.maxKg)} kg</span></span><span class="dd-check">✓</span>
            </button>`).join('')}
          <div class="dd-foot">Pick several to combine bands</div>
        </div>` : ''}
    </div>`;
}

function closeBandMenu() {
  if (!ui.bandMenu) return;
  ui.bandMenu = null;
  document.querySelectorAll('.dd-menu').forEach((m) => m.remove());
  document.querySelectorAll('.dd-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

/** "L2 10s / 9s / 8s [band] assist" — grouped by level + load so it stays short. */
function lastTimeLine(ex, sets) {
  const groups = [];
  for (const x of sets) {
    const key = `${x.level}|${x.tempo || ''}|${loadInline(x)}`;
    const g = groups.at(-1);
    if (g && g.key === key) g.vals.push(x.value);
    else groups.push({ key, level: x.level, set: x, vals: [x.value] });
  }
  return groups.map((g) => `<span class="row" style="gap:5px"><span class="small">L${g.level + 1}</span>${tempoTag(g.set)}
    <span class="num" style="color:var(--text)">${g.vals.map((v) => esc(fmtVal(ex, v))).join(' / ')}</span>${loadInline(g.set)}</span>`).join('<span class="muted">·</span>');
}

// ---------- Skills ----------
function viewSkills() {
  const list = state.exercises.filter((e) => !e.archived);
  const archived = state.exercises.filter((e) => e.archived);
  const groups = GROUPS.map((g) => ({ g, items: list.filter((e) => (e.group || 'Other') === g) })).filter((x) => x.items.length);
  return `
    <div class="spread view-head"><h2>Progressions</h2><button class="btn sm" data-act="edit-ex" data-id="new">+ New</button></div>
    ${groups.map(({ g, items }) => `
      <div class="label" style="margin:16px 0 8px">${esc(g)}</div>
      ${items.map(skillCard).join('')}`).join('')}
    ${archived.length ? `
      <button class="btn ghost block" style="margin-top:16px" data-act="toggle-archived">${ui.showArchived ? 'Hide' : 'Show'} archived (${archived.length})</button>
      ${ui.showArchived ? archived.map(skillCard).join('') : ''}` : ''}`;
}

function skillCard(ex) {
  const r = S.readiness(ex);
  return `
    <div class="card tap" data-act="open-ex" data-id="${ex.id}">
      <div class="spread">
        <div>
          <h3>${esc(ex.name)}</h3>
          <div class="small muted">L${ex.currentLevel + 1}/${ex.levels.length} · <span style="color:var(--text)">${esc(ex.levels[ex.currentLevel])}</span>${ex.equipment && ex.equipment !== 'none' ? ` · ${EQUIPMENT[ex.equipment]}` : ''}</div>
        </div>
        ${r.ready ? '<span class="badge ready">Level up</span>' : r.isLast && r.hits >= 2 ? '<span class="badge ready">Mastered</span>' : `<span class="badge ${ex.kind === 'static' ? 'kind-static' : ''}">${ex.kind === 'static' ? 'Hold' : 'Reps'}</span>`}
      </div>
      ${ladderBar(ex)}
      <div class="spread small muted" style="margin-top:10px">
        <span>Best clean ${r.bestClean ? fmtVal(ex, r.bestClean) : '—'} / ${fmtVal(ex, ex.goal)}</span>
        ${r.bestAny && S.isAssisted(r.bestAny) ? `<span class="row">best ${fmtVal(ex, r.bestAny.value)} ${loadInline(r.bestAny)}</span>` : ''}
      </div>
      <div class="goalbar" style="margin-top:6px"><b style="width:${(r.pct * 100).toFixed(0)}%"></b></div>
    </div>`;
}

function sheetExercise(ex) {
  const hist = S.historyFor(ex.id);
  const recent = hist.slice(-8).reverse();
  return `
    <div class="sheet-head">
      <h2>${esc(ex.name)}</h2>
      <div class="row">
        <button class="btn sm" data-act="edit-ex" data-id="${ex.id}">Edit</button>
        <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
      </div>
    </div>
    <div class="label">Progression ladder · tap to set your working level</div>
    <ul class="levels card" style="padding:4px 10px;margin-top:8px">
      ${ex.levels.map((name, i) => {
        const best = S.bestOf(hist.flatMap((h) => h.sets).filter((x) => x.level === i));
        return `<li class="${i < ex.currentLevel ? 'done' : i === ex.currentLevel ? 'cur' : ''}" data-act="set-level" data-id="${ex.id}" data-lvl="${i}">
          <span class="lv-n">${i + 1}</span>
          <span class="lv-name">${esc(name)}</span>
          <span class="small muted row">${best ? `${fmtVal(ex, best.value)} ${loadInline(best)}` : ''}</span>
        </li>`;
      }).join('')}
    </ul>

    <h2>Progress</h2>
    <div class="card">${chart(ex)}</div>

    <h2>Recent sessions</h2>
    ${recent.length ? recent.map((h) => `
      <div class="card">
        <div class="spread"><b>${fmtDate(h.session.startedAt)}</b><span class="small muted">${h.sets.length} set${h.sets.length > 1 ? 's' : ''}</span></div>
        <ul class="sets" style="border-top:0;margin-top:4px">
          ${h.sets.map((x) => `<li style="grid-template-columns:1fr auto">
            <span><span class="small">L${x.level + 1} · ${esc(x.levelName)}</span><br>${loadInline(x)}</span>
            <span class="s-v">${esc(x.value)}<small>${unit(ex)}</small></span></li>`).join('')}
        </ul>
      </div>`).join('') : '<div class="empty small">No sets logged yet.</div>'}`;
}

/**
 * Progress chart: best set per session. Shaded columns = progression level,
 * dot color = the band that assisted (accent = clean / loaded), dashed = goal.
 */
function chart(ex) {
  const hist = S.historyFor(ex.id).slice(-20);
  if (hist.length < 2) {
    return `<div class="empty small" style="border:0">Log ${2 - hist.length} more session${hist.length === 1 ? '' : 's'} to see the chart.</div>`;
  }
  const W = 320, H = 170, pl = 28, pr = 10, pt = 22, pb = 16;
  const vals = hist.map((h) => h.top.value);
  const maxV = Math.max(ex.goal, ...vals) * 1.15 || 1;
  const n = hist.length, step = (W - pl - pr) / (n - 1);
  const x = (i) => pl + i * step;
  const y = (v) => pt + (1 - v / maxV) * (H - pt - pb);

  const segs = [];
  hist.forEach((h, i) => {
    const last = segs.at(-1);
    if (last && last.level === h.top.level) last.end = i;
    else segs.push({ level: h.top.level, start: i, end: i });
  });

  const dotColor = (set) => {
    if (!S.isAssisted(set)) return 'var(--accent)';
    const heaviest = set.bands.map(S.bandById).filter(Boolean).sort((a, b) => b.widthMm - a.widthMm)[0];
    return heaviest ? esc(heaviest.color) : 'var(--accent)';
  };

  const cols = segs.map((s, k) => {
    const x0 = Math.max(pl - 6, x(s.start) - step / 2), x1 = Math.min(W - pr + 4, x(s.end) + step / 2);
    return `<rect x="${x0.toFixed(1)}" y="${pt - 14}" width="${(x1 - x0).toFixed(1)}" height="${H - pt - pb + 14}"
        style="fill:var(--surface-2);opacity:${k % 2 ? 0.35 : 0.9}"/>
      <text class="lvl-label" x="${(x0 + 4).toFixed(1)}" y="${pt - 4}">L${s.level + 1}</text>`;
  }).join('');
  const lines = segs.map((s) => {
    const pts = hist.slice(s.start, s.end + 1).map((h, j) => `${x(s.start + j).toFixed(1)},${y(h.top.value).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" style="fill:none;stroke:var(--text);stroke-width:1.5;opacity:.55"/>`;
  }).join('');
  const dots = hist.map((h, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(h.top.value).toFixed(1)}" r="4.5"
      style="fill:${dotColor(h.top)};stroke:var(--muted);stroke-width:1.2">
      <title>${esc(fmtDate(h.session.startedAt))}: ${esc(h.top.levelName)} ${esc(fmtVal(ex, h.top.value))}</title></circle>`).join('');
  const gy = y(ex.goal);

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Best set per session for ${esc(ex.name)}">
      ${cols}
      <line x1="${pl - 6}" x2="${W - pr}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" style="stroke:var(--accent);stroke-dasharray:3 3;opacity:.8"/>
      <text x="2" y="${(gy + 3).toFixed(1)}">${esc(fmtVal(ex, ex.goal))}</text>
      <text x="2" y="${H - pb + 3}">0</text>
      ${lines}${dots}
      <text x="${pl - 6}" y="${H - 3}">${esc(fmtDate(hist[0].session.startedAt))}</text>
      <text x="${W - pr}" y="${H - 3}" text-anchor="end">${esc(fmtDate(hist.at(-1).session.startedAt))}</text>
    </svg>
    <div class="legend">
      <span><span class="dot" style="background:var(--accent)"></span>clean</span>
      <span><span class="dot" style="background:var(--muted)"></span>dot = assisting band color</span>
      <span>L = progression level</span>
    </div>`;
}

function sheetEditor(ex) {
  const isNew = !ex;
  ex ||= { name: '', kind: 'static', group: 'Pull', equipment: 'bar', goal: 15, levels: ['Level 1', 'Level 2', 'Level 3'], currentLevel: 0 };
  return `
    <div class="sheet-head">
      <h2>${isNew ? 'New progression' : 'Edit progression'}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
    </div>
    <form class="stack" id="ex-form" data-id="${isNew ? 'new' : ex.id}">
      <label class="field"><span>Name</span><input class="input" name="name" required value="${esc(ex.name)}" placeholder="e.g. Front lever"></label>
      <div class="grid2">
        <label class="field"><span>Type</span>
          <select class="input" name="kind">
            <option value="static" ${ex.kind === 'static' ? 'selected' : ''}>Static hold (s)</option>
            <option value="reps" ${ex.kind === 'reps' ? 'selected' : ''}>Reps</option>
          </select></label>
        <label class="field"><span>Group</span>
          <select class="input" name="group">${GROUPS.map((g) => `<option ${g === ex.group ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
      </div>
      <div class="field"><span>Equipment</span>
        <div class="seg seg-radio" role="radiogroup" aria-label="Equipment">
          ${Object.entries(EQUIPMENT).map(([k, label]) => `
            <label><input type="radio" name="equipment" value="${k}" ${(ex.equipment || 'none') === k ? 'checked' : ''}>${label}</label>`).join('')}
        </div>
      </div>
      <div class="field"><span>Load options</span>
        <div class="toggles">
          <label class="toggle"><input type="checkbox" name="allowBands" ${ex.allowBands !== false ? 'checked' : ''}><span>Resistance bands</span></label>
          <label class="toggle"><input type="checkbox" name="allowWeight" ${ex.allowWeight !== false ? 'checked' : ''}><span>Added weight</span></label>
        </div>
      </div>
      <label class="field"><span>Goal to level up (clean, no assist band)</span>
        <input class="input num" name="goal" type="number" min="1" inputmode="numeric" value="${esc(ex.goal)}"></label>
      <label class="field"><span>Progression levels — one per line, easiest first</span>
        <textarea class="input" name="levels">${esc(ex.levels.join('\n'))}</textarea></label>
      <button class="btn primary block big" type="submit">Save</button>
      ${isNew ? '' : `
        <div class="grid2">
          <button class="btn ghost" type="button" data-act="archive-ex" data-id="${ex.id}">${ex.archived ? 'Unarchive' : 'Archive'}</button>
          <button class="btn danger" type="button" data-act="delete-ex" data-id="${ex.id}">Delete</button>
        </div>`}
    </form>`;
}

function sheetPicker() {
  const s = S.activeSession();
  const list = state.exercises.filter((e) => !e.archived);
  const groups = GROUPS.map((g) => ({ g, items: list.filter((e) => (e.group || 'Other') === g) })).filter((x) => x.items.length);
  const allCollapsed = groups.every(({ g }) => ui.pickerCollapsed.has(g));
  return `
    <div class="sheet-head">
      <h2>Add exercise</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
    </div>
    <div class="picker-tools">
      <input class="input" type="search" placeholder="Search exercises or levels…" value="${esc(ui.pickerQuery)}"
        data-picker-search aria-label="Search exercises" autocomplete="off" enterkeyhint="search">
      <button class="btn sm ghost" data-act="picker-collapse-all">${allCollapsed ? 'Expand all' : 'Collapse all'}</button>
    </div>
    ${groups.map(({ g, items }) => `
      <section class="pick-group ${ui.pickerCollapsed.has(g) ? 'collapsed' : ''}" data-group="${g}">
        <button class="pick-head" data-act="picker-group" data-g="${g}" aria-expanded="${!ui.pickerCollapsed.has(g)}">
          <span class="dot g-${g.toLowerCase()}"></span><span class="label">${g}</span>
          <span class="small muted pick-count">${items.length}</span><span class="pick-chev">▾</span>
        </button>
        <ul class="pick-list">${items.map((ex) => {
          const added = s?.exerciseIds.includes(ex.id);
          const search = [ex.name, g, EQUIPMENT[ex.equipment] || '', ...ex.levels].join(' ').toLowerCase();
          return `<li class="${added ? 'added' : ''}" data-act="pick-ex" data-id="${ex.id}" data-search="${esc(search)}">
            <span><b>${esc(ex.name)}</b><br><span class="small muted">L${ex.currentLevel + 1} · ${esc(ex.levels[ex.currentLevel])}${ex.equipment && ex.equipment !== 'none' ? ` · ${EQUIPMENT[ex.equipment]}` : ''}</span></span>
            <span class="badge ${ex.kind === 'static' ? 'kind-static' : ''}">${added ? 'Added' : ex.kind === 'static' ? 'Hold' : 'Reps'}</span>
          </li>`;
        }).join('')}</ul>
      </section>`).join('')}
    <div class="empty small" data-picker-empty hidden>No exercise matches. Create it as a new progression below.</div>
    <button class="btn block ghost" style="margin-top:14px" data-act="edit-ex" data-id="new">+ Create new progression</button>`;
}

/**
 * Filter the picker in place (no re-render, so the search box keeps focus).
 * While searching, groups with matches are shown expanded regardless of collapse state.
 */
function applyPickerFilter() {
  const q = ui.pickerQuery.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  let any = false;
  document.querySelectorAll('.pick-group').forEach((sec) => {
    let n = 0;
    sec.querySelectorAll('li[data-search]').forEach((li) => {
      const hit = terms.every((t) => li.dataset.search.includes(t));
      li.hidden = !hit;
      if (hit) n++;
    });
    sec.hidden = n === 0;
    sec.classList.toggle('searching', terms.length > 0);
    sec.querySelector('.pick-count').textContent = n;
    if (n) any = true;
  });
  const empty = document.querySelector('[data-picker-empty]');
  if (empty) empty.hidden = any;
}

// ---------- PRs ----------
const fmtDay = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const inGroups = (ex, set) => !set.size || set.has(ex.group || 'Other');

function viewPRs() {
  const f = ui.prGroups;
  const rows = state.exercises
    .filter((ex) => inGroups(ex, f))
    .map((ex) => ({ ex, pr: S.prsFor(ex.id) }))
    .filter((x) => x.pr.top);
  const recent = S.recentPRs(50).filter((ev) => inGroups(ev.ex, f)).slice(0, 4);
  const groups = GROUPS.map((g) => ({ g, items: rows.filter((r) => (r.ex.group || 'Other') === g) })).filter((x) => x.items.length);
  return `
    <div class="spread view-head"><h2>Personal records</h2><button class="btn sm" data-act="pr-add">+ Add PR</button></div>
    ${groupFilter(f, 'pr-group').replace('class="gfilter"', 'class="gfilter left"')}

    ${recent.length ? `
      <div class="label" style="margin:16px 0 6px">Recent</div>
      <ul class="pr-recent">${recent.map((ev) => `
        <li>
          <span class="pr-star ${ev.type === 'level' ? 'lvl' : ''}" title="${ev.type === 'level' ? 'New level' : 'PR'}">${ev.type === 'level' ? '▲' : '★'}</span>
          <span class="pr-name"><b>${esc(ev.ex.name)}</b> <span class="muted">${esc(ev.entry.levelName)}</span></span>
          <span class="pr-num">${esc(fmtVal(ev.ex, ev.entry.value))}</span>
          <span class="small muted pr-date">${fmtShort(ev.entry.date)}</span>
        </li>`).join('')}
      </ul>` : ''}

    ${groups.length ? groups.map(({ g, items }) => `
      <div class="label" style="margin:16px 0 6px"><span class="dot g-${g.toLowerCase()}" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>${g}</div>
      <div class="card pr-table">${items.map(({ ex, pr }) => prRowCompact(ex, pr)).join('')}</div>`).join('')
      : `<div class="empty" style="margin-top:16px">No records${f.size ? ' in this group' : ''} yet.<br><span class="small">They appear automatically as you log sets, or add one manually.</span></div>`}`;
}

const fmtShort = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** One line per exercise: name, top level, value. Tap to expand per-level bests. */
function prRowCompact(ex, pr) {
  const top = pr.top;
  const open = ui.prOpen.has(ex.id);
  return `
    <div class="pr-row ${open ? 'open' : ''}">
      <button class="pr-main" data-act="pr-toggle" data-id="${ex.id}" aria-expanded="${open}">
        <span class="pr-name"><b>${esc(ex.name)}</b>
          <span class="small muted">L${top.level + 1}/${ex.levels.length} · ${esc(top.levelName)}${top.tempo ? ` · ${esc(TEMPOS[top.tempo].toLowerCase())}` : ''}${S.isAssisted(top) ? ' · band' : ''}</span></span>
        <span class="pr-num">${esc(top.value)}<small>${ex.kind === 'static' ? 's' : ''}</small></span>
        <span class="pr-chev">${open ? '▴' : '▾'}</span>
      </button>
      ${open ? `
        <ul class="pr-list">${pr.levels.map((e) => prRow(ex, e)).join('')}</ul>
        <div class="row" style="justify-content:flex-end;padding:6px 0 4px">
          <button class="btn sm ghost" data-act="pr-add" data-id="${ex.id}">+ Manual PR</button>
        </div>` : ''}
    </div>`;
}

function prRow(ex, e) {
  return `<li>
    <span class="pl-lv">L${e.level + 1}</span>
    <span>${esc(e.levelName)} ${tempoTag(e)}<br><span class="small muted">${fmtDay(e.date)}${e.manual ? ' · manual' : ''}${e.note ? ` · ${esc(e.note)}` : ''}</span></span>
    <span class="row" style="justify-content:flex-end">${loadInline(e)}<span class="pl-v">${esc(fmtVal(ex, e.value))}</span></span>
    ${e.manual ? `<button class="icon-btn plain" data-act="pr-del" data-id="${e.id}" aria-label="Delete manual PR">×</button>` : '<span></span>'}
  </li>`;
}

function prLevelOptions(ex, selected = ex.currentLevel) {
  return ex.levels.map((name, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>L${i + 1} · ${esc(name)}</option>`).join('');
}

function sheetAddPR(exId) {
  const list = state.exercises.filter((e) => !e.archived);
  const ex = S.exById(exId) || list[0];
  if (!ex) return '<div class="empty">Create an exercise first.</div>';
  const bands = [...state.bands].sort((a, b) => (a.widthMm || 0) - (b.widthMm || 0));
  return `
    <div class="sheet-head">
      <h2>Add PR</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
    </div>
    <p class="small muted" style="margin-top:0">For records set outside a logged session, or before you used CaliTracker.</p>
    <form class="stack" id="pr-form">
      <label class="field"><span>Exercise</span>
        <select class="input" name="exId">
          ${GROUPS.map((g) => {
            const items = list.filter((e) => (e.group || 'Other') === g);
            return items.length ? `<optgroup label="${g}">${items.map((e) => `<option value="${e.id}" ${e.id === ex.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</optgroup>` : '';
          }).join('')}
        </select></label>
      <label class="field"><span>Progression level</span>
        <select class="input" name="level">${prLevelOptions(ex)}</select></label>
      <div class="grid2">
        <label class="field"><span data-pr-unit>${ex.kind === 'static' ? 'Hold (seconds)' : 'Reps'}</span>
          <input class="input num" name="value" type="number" min="1" inputmode="numeric" required></label>
        <label class="field"><span>Date</span>
          <input class="input" name="date" type="date" value="${dayKey(Date.now())}" max="${dayKey(Date.now())}" required></label>
      </div>
      <div class="grid2" data-pr-bands ${ex.allowBands === false ? 'hidden' : ''}>
        <label class="field"><span>Band</span>
          <select class="input" name="band">
            <option value="">No band</option>
            ${bands.map((b) => `<option value="${b.id}">${esc(b.name)} · ${esc(b.widthMm)} mm</option>`).join('')}
          </select></label>
        <label class="field"><span>Band mode</span>
          <select class="input" name="bandMode"><option value="assist">Assist</option><option value="resist">Resist</option></select></label>
      </div>
      <label class="field" data-pr-tempo ${ex.kind === 'reps' ? '' : 'hidden'}><span>Tempo</span>
        <select class="input" name="tempo">
          <option value="">Standard</option>
          ${Object.entries(TEMPOS).map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}
        </select></label>
      <label class="field" data-pr-weight ${ex.allowWeight === false ? 'hidden' : ''}><span>Added weight (kg, optional)</span>
        <input class="input num" name="addedKg" type="number" min="0" step="0.5" inputmode="decimal" placeholder="0"></label>
      <label class="field"><span>Note (optional)</span>
        <input class="input" name="note" placeholder="e.g. tested at the gym, filmed"></label>
      <button class="btn primary block big" type="submit">Save PR</button>
    </form>`;
}

// ---------- Bands ----------
function viewBands() {
  const bands = [...state.bands].sort((a, b) => (a.widthMm || 0) - (b.widthMm || 0));
  return `
    <div class="spread view-head"><h2>Band inventory</h2><button class="btn sm" data-act="add-band">+ Band</button></div>
    <p class="small muted" style="margin-top:0">Color and width identify the band. The kg range is used to rank assisted sets
      (lighter assist = progress). Combine several bands when logging.</p>
    ${bands.map((b) => `
      <div class="card">
        <div class="band-row">
          <input type="color" value="${esc(b.color)}" data-band="${b.id}" data-field="color" aria-label="Band color">
          <input class="input" value="${esc(b.name)}" data-band="${b.id}" data-field="name" aria-label="Band name">
          <button class="icon-btn plain" data-act="del-band" data-id="${b.id}" aria-label="Delete band">×</button>
        </div>
        <div class="band-visual">${swatch(b)}</div>
        <div class="grid3" style="margin-top:10px">
          <label class="field"><span>Width mm</span><input class="input num" type="number" min="1" inputmode="decimal" value="${esc(b.widthMm)}" data-band="${b.id}" data-field="widthMm"></label>
          <label class="field"><span>Min kg</span><input class="input num" type="number" min="0" inputmode="decimal" value="${esc(b.minKg)}" data-band="${b.id}" data-field="minKg"></label>
          <label class="field"><span>Max kg</span><input class="input num" type="number" min="0" inputmode="decimal" value="${esc(b.maxKg)}" data-band="${b.id}" data-field="maxKg"></label>
        </div>
      </div>`).join('') || '<div class="empty">No bands yet.</div>'}`;
}

// ---------- History ----------
function sessionCard(s, compact = false, groups = null) {
  const open = ui.openSessions.has(s.id);
  const byEx = s.exerciseIds.length ? s.exerciseIds : [...new Set(s.sets.map((x) => x.exId))];
  const lines = byEx.map((id) => {
    const ex = S.exById(id);
    const sets = s.sets.filter((x) => x.exId === id);
    if (!ex || !sets.length) return '';
    if (groups?.size && !groups.has(ex.group || 'Other')) return '';
    const top = S.bestOf(sets);
    const vals = sets.map((x) => esc(fmtVal(ex, x.value))).join(' / ');
    return `<div style="padding:7px 0;border-top:1px solid var(--line)">
      <div class="spread"><b>${esc(ex.name)}</b><span class="num">${vals}</span></div>
      <div class="small muted">L${top.level + 1} · ${esc(top.levelName)}</div>
    </div>`;
  }).join('');
  return `
    <div class="card">
      <div class="spread" ${compact ? '' : `data-act="toggle-session" data-id="${s.id}" style="cursor:pointer"`}>
        <b>${fmtDate(s.startedAt)}</b>
        <span class="small muted">${s.sets.length} set${s.sets.length === 1 ? '' : 's'}${s.endedAt ? ` · ${fmtDur(s.endedAt - s.startedAt)}` : ' · in progress'}</span>
      </div>
      <div style="margin-top:8px">${lines}</div>
      ${open && !compact ? `<button class="btn danger sm" style="margin-top:8px" data-act="del-session" data-id="${s.id}">Delete session</button>` : ''}
    </div>`;
}

function viewCalendar(sessions) {
  const m = ui.calMonth;
  const y = m.getFullYear(), mo = m.getMonth();
  const offset = (new Date(y, mo, 1).getDay() + 6) % 7; // Monday-first weeks
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const filter = ui.calGroups;
  const visibleGroups = (s) => groupsTrained(s).filter((g) => !filter.size || filter.has(g));
  sessions = sessions.filter((s) => visibleGroups(s).length);
  const byDay = {};
  for (const s of sessions) (byDay[dayKey(s.startedAt)] ||= []).push(s);
  const today = dayKey(Date.now());
  const inMonth = sessions.filter((s) => { const d = new Date(s.startedAt); return d.getFullYear() === y && d.getMonth() === mo; });
  const inFilter = (x) => !filter.size || filter.has(S.exById(x.exId)?.group || 'Other');
  const monthSets = inMonth.reduce((a, s) => a + s.sets.filter(inFilter).length, 0);
  const weekdays = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));

  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<span class="cal-cell blank"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const daySessions = byDay[key] || [];
    const groups = [...new Set(daySessions.flatMap(visibleGroups))];
    cells.push(`<button class="cal-cell ${daySessions.length ? 'has' : ''} ${key === today ? 'today' : ''} ${key === ui.calDay ? 'sel' : ''}"
        data-act="cal-day" data-day="${key}" ${daySessions.length ? '' : 'disabled'} aria-label="${d}${daySessions.length ? `, ${daySessions.length} session` : ''}">
      <span class="cal-n">${d}</span>
      <span class="cal-dots">${groups.slice(0, 4).map((g) => `<i class="g-${g.toLowerCase()}"></i>`).join('')}</span>
    </button>`);
  }
  const shown = ui.calDay && byDay[ui.calDay] ? byDay[ui.calDay] : inMonth;
  const shownTitle = ui.calDay && byDay[ui.calDay]
    ? new Date(`${ui.calDay}T12:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
    : 'This month';
  return `
    <div class="card cal">
      <div class="spread">
        <button class="icon-btn plain" data-act="cal-month" data-d="-1" aria-label="Previous month">‹</button>
        <div style="text-align:center">
          <h3>${m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
          <div class="small muted">${inMonth.length} session${inMonth.length === 1 ? '' : 's'} · ${monthSets} sets</div>
        </div>
        <button class="icon-btn plain" data-act="cal-month" data-d="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid cal-head">${weekdays.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
      ${groupFilter(filter, 'cal-group')}
    </div>
    <div class="spread" style="margin:16px 0 8px">
      <span class="label">${esc(shownTitle)}</span>
      ${ui.calDay ? '<button class="btn sm ghost" data-act="cal-day" data-day="">Show month</button>' : ''}
    </div>
    ${shown.length ? shown.map((s) => sessionCard(s, false, filter)).join('')
      : `<div class="empty small">No ${filter.size ? [...filter].join(' / ').toLowerCase() + ' ' : ''}sessions this month.</div>`}`;
}

/** Tappable group chips (Push / Pull / Core / Legs). Empty selection = all groups. */
function groupFilter(selected, act) {
  return `<div class="gfilter" role="group" aria-label="Filter by muscle group">
    ${GROUPS.slice(0, 4).map((g) => `<button class="gchip" data-act="${act}" data-g="${g}" aria-pressed="${selected.has(g)}">
      <span class="dot g-${g.toLowerCase()}"></span>${g}</button>`).join('')}
    ${selected.size ? `<button class="gchip clear" data-act="${act}" data-g="">All</button>` : ''}
  </div>`;
}

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const groupsTrained = (s) => [...new Set(s.sets.map((x) => S.exById(x.exId)?.group || 'Other'))];

function viewHistory() {
  const sessions = [...state.sessions].sort((a, b) => b.startedAt - a.startedAt);
  const mode = state.historyView === 'calendar' ? 'calendar' : 'list';
  return `
    <div class="spread view-head">
      <h2>Sessions</h2>
      <div class="seg" role="group" aria-label="History view">
        <button data-act="history-view" data-v="list" aria-pressed="${mode === 'list'}">List</button>
        <button data-act="history-view" data-v="calendar" aria-pressed="${mode === 'calendar'}">Calendar</button>
      </div>
    </div>
    ${mode === 'calendar' ? viewCalendar(sessions)
      : sessions.length ? sessions.map((s) => sessionCard(s)).join('') : '<div class="empty">No sessions yet.</div>'}
`;
}

// ---------- Settings (Skills, Bands, Data) ----------
function viewSettings() {
  const t = ui.settingsTab;
  const body = t === 'bands' ? viewBands() : t === 'data' ? viewData() : viewSkills();
  return `
    <div class="seg seg-full" role="tablist" aria-label="Settings sections" style="margin-bottom:6px">
      <button role="tab" data-act="settings-tab" data-t="skills" aria-pressed="${t === 'skills'}">Skills</button>
      <button role="tab" data-act="settings-tab" data-t="bands" aria-pressed="${t === 'bands'}">Bands</button>
      <button role="tab" data-act="settings-tab" data-t="data" aria-pressed="${t === 'data'}">Data</button>
    </div>
    ${body}`;
}

function viewData() {
  return `
    <h2>Rest timer & backup</h2>
    <div class="card stack">
      <label class="field"><span>Rest timer after each set (seconds, 0 = off)</span>
        <input class="input num" type="number" min="0" step="15" inputmode="numeric" value="${esc(state.restSeconds ?? 90)}" data-setting="restSeconds"></label>
      <div class="grid2">
        <button class="btn" data-act="export">Export JSON</button>
        <label class="btn" style="cursor:pointer">Import JSON<input type="file" accept="application/json,.json" hidden data-import></label>
      </div>
      <p class="small muted" style="margin:0">Data lives only in this browser. Export regularly to keep a backup.</p>
      <button class="btn danger block" data-act="reset">Reset all data</button>
    </div>`;
}

// ---------- sheet rendering ----------
function renderSheet() {
  const wrap = $('#sheet');
  if (!ui.sheet) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  const { type, id } = ui.sheet;
  let body = '';
  if (type === 'ex') { const ex = S.exById(id); if (!ex) { ui.sheet = null; return renderSheet(); } body = sheetExercise(ex); }
  if (type === 'edit') body = sheetEditor(id === 'new' ? null : S.exById(id));
  if (type === 'picker') body = sheetPicker();
  if (type === 'pr-add') body = sheetAddPR(id);
  const scroll = wrap.querySelector('.sheet')?.scrollTop || 0;
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${body}</div>`;
  wrap.hidden = false;
  wrap.querySelector('.sheet').scrollTop = scroll;
  if (type === 'picker') applyPickerFilter();
}

function openSheet(type, id) { ui.sheet = { type, id }; renderSheet(); }
function closeSheet() { ui.sheet = null; renderSheet(); }

// ---------- topbar ----------
function updateTopbar() {
  const s = S.activeSession();
  const el = $('#topbar-meta');
  el.textContent = s ? `Session ${fmtClock((Date.now() - s.startedAt) / 1000)}` : '';
  if (s) el.title = `${s.sets.length} set${s.sets.length === 1 ? '' : 's'} logged`;
  el.hidden = !s;
}

// ================= HOLD TIMER =================
const COUNTDOWN = 3;

function startTimer(exId) {
  beep(660, 0.05); // also unlocks audio on iOS within the user gesture
  ui.timer = { exId, phase: 'ready', t0: performance.now() + COUNTDOWN * 1000, start: 0, elapsed: 0, hit: false };
  holdWake(true);
  renderTimer();
  tick();
}

function tick() {
  const t = ui.timer;
  if (!t || t.phase === 'done') return;
  const now = performance.now();
  const ex = S.exById(t.exId);
  if (t.phase === 'ready' && now >= t.t0) {
    t.phase = 'hold'; t.start = t.t0; beep(990, 0.18);
    renderTimer();
  }
  if (t.phase === 'hold') {
    t.elapsed = (now - t.start) / 1000;
    if (!t.hit && t.elapsed >= ex.goal) { t.hit = true; beep(1320, 0.12, 2); $('#timer').classList.add('hit'); }
  }
  updateTimerDigits();
  t.raf = requestAnimationFrame(tick);
}

function updateTimerDigits() {
  const t = ui.timer, ex = S.exById(t.exId);
  const el = $('#timer .t-digits');
  if (!el) return;
  if (t.phase === 'ready') el.textContent = Math.ceil((t.t0 - performance.now()) / 1000);
  else if (t.phase === 'hold') {
    el.textContent = t.elapsed < 60 ? t.elapsed.toFixed(1) : fmtClock(t.elapsed);
    const bar = $('#timer .goalbar > b');
    if (bar) bar.style.width = `${Math.min(100, (t.elapsed / ex.goal) * 100)}%`;
  }
}

function renderTimer() {
  const el = $('#timer');
  const t = ui.timer;
  if (!t) { el.hidden = true; el.innerHTML = ''; el.className = 'timer'; return; }
  const ex = S.exById(t.exId);
  const d = draftFor(t.exId);
  const bands = d.bands.map(S.bandById).filter(Boolean);
  el.className = `timer ${t.phase === 'ready' ? 'ready' : ''} ${t.hit ? 'hit' : ''}`;
  const head = `
    <div class="t-ex">${esc(ex.name)}</div>
    <div class="row">${esc(ex.levels[d.level])} ${bands.length ? `· <span class="band-inline">${bands.map((b) => swatch(b)).join('')}</span> <span class="small muted">${d.bandMode}</span>` : ''}</div>`;
  if (t.phase === 'done') {
    el.innerHTML = `${head}
      <div class="t-phase">Held</div>
      <div class="t-digits">${t.result}<span style="font-size:.3em">s</span></div>
      <div class="counter" style="width:min(86vw,380px)">
        <button data-act="timer-adj" data-d="-1" aria-label="Minus one second">−</button>
        <div class="small muted">adjust</div>
        <button data-act="timer-adj" data-d="1" aria-label="Plus one second">+</button>
      </div>
      <div class="t-actions">
        <button class="btn ghost big" data-act="timer-discard">Discard</button>
        <button class="btn primary big" data-act="timer-log">Log ${t.result}s</button>
      </div>`;
  } else {
    el.innerHTML = `${head}
      <div class="t-phase">${t.phase === 'ready' ? 'Get into position' : `Hold · goal ${ex.goal}s`}</div>
      <div class="t-digits">${t.phase === 'ready' ? COUNTDOWN : '0.0'}</div>
      <div class="goalbar t-goal"><b style="width:0"></b></div>
      <div class="tap-zone">
        ${t.phase === 'ready'
          ? '<button class="btn ghost big block" data-act="timer-cancel">Cancel</button>'
          : '<button class="btn primary big block" style="min-height:96px;font-size:24px" data-act="timer-stop">STOP</button>'}
      </div>`;
  }
  el.hidden = false;
}

function stopTimer() {
  const t = ui.timer;
  if (!t) return;
  cancelAnimationFrame(t.raf);
  t.phase = 'done';
  t.result = Math.round(t.elapsed);
  holdWake(false);
  renderTimer();
}

function closeTimer() {
  if (ui.timer) cancelAnimationFrame(ui.timer.raf);
  ui.timer = null;
  holdWake(false);
  renderTimer();
}

// ================= REST TIMER =================
function startRest() {
  const secs = Number(state.restSeconds ?? 90);
  if (!secs) return;
  ui.rest = { end: Date.now() + secs * 1000, done: false };
  renderRest();
}
function renderRest() {
  const el = $('#rest');
  const r = ui.rest;
  if (!r) { el.hidden = true; return; }
  const left = (r.end - Date.now()) / 1000;
  if (left <= 0 && !r.done) {
    r.done = true; beep(880, 0.15, 3);
    setTimeout(() => { if (ui.rest === r) { ui.rest = null; renderRest(); } }, 8000);
  }
  el.className = `rest ${r.done ? 'done' : ''}`;
  el.innerHTML = `<span class="r-l">${r.done ? 'Go' : 'Rest'}</span><span class="r-t">${r.done ? '0:00' : fmtClock(Math.ceil(left))}</span>
    ${r.done ? '' : '<button data-act="rest-add">+15</button>'}<button data-act="rest-close" aria-label="Close rest timer">×</button>`;
  el.hidden = false;
}

// ================= ACTIONS =================
function logAndCelebrate(exId, draft) {
  const set = S.logSet(exId, draft);
  startRest();
  const ev = set && S.prsFor(exId).events.find((e) => e.entry.id === set.id);
  if (ev) {
    const ex = S.exById(exId);
    toast(ev.type === 'level'
      ? `★ New level · ${ex.name}: ${set.levelName}`
      : `★ New PR · ${ex.name} L${set.level + 1}${set.tempo ? ` ${TEMPOS[set.tempo].toLowerCase()}` : ''}: ${fmtVal(ex, set.value)}`);
    beep(1320, 0.1, 2);
  }
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function toggleGroup(set, g) {
  if (!g) set.clear();
  else if (set.has(g)) set.delete(g);
  else set.add(g);
}

const actions = {
  tab: (el) => { ui.tab = el.dataset.tab; ui.sheet = null; render(); window.scrollTo(0, 0); },
  // The session itself starts when the first exercise is picked (see pick-ex).
  'start-session': () => { ui.drafts = {}; ui.pickerQuery = ''; openSheet('picker'); },
  'finish-session': () => {
    const s = S.activeSession();
    if (s && s.sets.length === 0 && !confirm('No sets logged. Discard this session?')) return;
    S.finishSession(); ui.drafts = {}; ui.rest = null; renderRest(); render();
  },
  'open-picker': () => { ui.pickerQuery = ''; openSheet('picker'); },
  'picker-group': (el) => {
    const g = el.dataset.g;
    const collapsed = !ui.pickerCollapsed.has(g);
    collapsed ? ui.pickerCollapsed.add(g) : ui.pickerCollapsed.delete(g);
    const sec = el.closest('.pick-group');
    sec.classList.toggle('collapsed', collapsed);
    el.setAttribute('aria-expanded', String(!collapsed));
  },
  'picker-collapse-all': () => {
    const gs = [...document.querySelectorAll('.pick-group')].map((x) => x.dataset.group);
    const collapse = !gs.every((g) => ui.pickerCollapsed.has(g));
    gs.forEach((g) => (collapse ? ui.pickerCollapsed.add(g) : ui.pickerCollapsed.delete(g)));
    renderSheet();
  },
  'pick-ex': (el) => {
    if (!S.activeSession()) S.startSession();
    S.addExerciseToSession(el.dataset.id); closeSheet(); ui.tab = 'workout'; render();
  },
  'remove-ex': (el) => {
    const s = S.activeSession();
    const n = s?.sets.filter((x) => x.exId === el.dataset.id).length || 0;
    if (n && !confirm(`Remove this exercise and its ${n} logged set(s)?`)) return;
    S.removeExerciseFromSession(el.dataset.id); delete ui.drafts[el.dataset.id]; render();
  },
  lvl: (el) => {
    const ex = S.exById(el.dataset.id), d = draftFor(ex.id);
    const next = clamp(d.level + Number(el.dataset.d), 0, ex.levels.length - 1);
    if (next !== d.level) { d.level = next; d.bands = []; d.addedKg = 0; ex.currentLevel = next; S.save(); }
    render();
  },
  mode: (el) => { draftFor(el.dataset.id).bandMode = el.dataset.m; render(); },
  band: (el) => {
    const d = draftFor(el.dataset.id), b = el.dataset.band;
    d.bands = d.bands.includes(b) ? d.bands.filter((x) => x !== b) : [...d.bands, b];
    render();
  },
  'band-clear': (el) => { draftFor(el.dataset.id).bands = []; ui.bandMenu = null; render(); },
  'band-menu': (el) => { ui.bandMenu = ui.bandMenu === el.dataset.id ? null : el.dataset.id; render(); },
  val: (el) => {
    const d = draftFor(el.dataset.id);
    d.value = Math.max(0, (Number(d.value) || 0) + Number(el.dataset.d));
    const input = document.querySelector(`input[data-bind="value"][data-id="${el.dataset.id}"]`);
    if (input) input.value = d.value; // no full re-render: keeps it snappy for repeated taps
  },
  hold: (el) => startTimer(el.dataset.id),
  log: (el) => {
    const ex = S.exById(el.dataset.id), d = draftFor(ex.id);
    if (!(Number(d.value) > 0)) { alert(`Enter ${ex.kind === 'static' ? 'hold seconds' : 'reps'} first.`); return; }
    logAndCelebrate(ex.id, d); render();
  },
  'del-set': (el) => { S.deleteSet(el.dataset.session, el.dataset.set); render(); },
  'open-ex': (el) => openSheet('ex', el.dataset.id),
  'set-level': (el) => {
    const ex = S.exById(el.dataset.id);
    ex.currentLevel = Number(el.dataset.lvl); S.save();
    if (ui.drafts[ex.id]) { ui.drafts[ex.id].level = ex.currentLevel; ui.drafts[ex.id].bands = []; }
    render();
  },
  'edit-ex': (el) => openSheet('edit', el.dataset.id),
  'archive-ex': (el) => {
    const ex = S.exById(el.dataset.id); ex.archived = !ex.archived; S.save(); closeSheet(); render();
  },
  'delete-ex': (el) => {
    const ex = S.exById(el.dataset.id);
    const n = state.sessions.reduce((a, s) => a + s.sets.filter((x) => x.exId === ex.id).length, 0);
    if (!confirm(`Delete "${ex.name}"${n ? ` and its ${n} logged sets` : ''}? This cannot be undone. (Archive keeps the history.)`)) return;
    state.exercises = state.exercises.filter((e) => e.id !== ex.id);
    state.manualPRs = (state.manualPRs || []).filter((p) => p.exId !== ex.id);
    for (const s of state.sessions) { s.sets = s.sets.filter((x) => x.exId !== ex.id); s.exerciseIds = s.exerciseIds.filter((id) => id !== ex.id); }
    S.save(); closeSheet(); render();
  },
  'toggle-archived': () => { ui.showArchived = !ui.showArchived; render(); },
  'close-sheet': () => closeSheet(),
  'add-band': () => {
    state.bands.push({ id: S.uid(), name: 'New band', color: '#ff9f1c', widthMm: 10, minKg: 5, maxKg: 12 });
    S.save(); render();
  },
  'del-band': (el) => {
    const used = state.sessions.some((s) => s.sets.some((x) => x.bands.includes(el.dataset.id)));
    if (used && !confirm('This band appears in logged sets. Delete anyway? Those sets will show no band.')) return;
    state.bands = state.bands.filter((b) => b.id !== el.dataset.id);
    S.save(); render();
  },
  'history-view': (el) => { state.historyView = el.dataset.v; S.save(); render(); },
  'cal-month': (el) => {
    const m = ui.calMonth;
    ui.calMonth = new Date(m.getFullYear(), m.getMonth() + Number(el.dataset.d), 1);
    ui.calDay = null; render();
  },
  tempo: (el) => { draftFor(el.dataset.id).tempo = el.dataset.t || null; render(); },
  'settings-tab': (el) => { ui.settingsTab = el.dataset.t; render(); window.scrollTo(0, 0); },
  'pr-add': (el) => openSheet('pr-add', el.dataset.id || null),
  'pr-toggle': (el) => { const id = el.dataset.id; ui.prOpen.has(id) ? ui.prOpen.delete(id) : ui.prOpen.add(id); render(); },
  'pr-del': (el) => { if (confirm('Delete this manual PR?')) { S.deleteManualPR(el.dataset.id); render(); } },
  'cal-group': (el) => { toggleGroup(ui.calGroups, el.dataset.g); ui.calDay = null; render(); },
  'pr-group': (el) => { toggleGroup(ui.prGroups, el.dataset.g); render(); },
  'cal-day': (el) => { ui.calDay = el.dataset.day && el.dataset.day !== ui.calDay ? el.dataset.day : null; render(); },
  'toggle-session': (el) => {
    const id = el.dataset.id;
    ui.openSessions.has(id) ? ui.openSessions.delete(id) : ui.openSessions.add(id);
    render();
  },
  'del-session': (el) => { if (confirm('Delete this session and all its sets?')) { S.deleteSession(el.dataset.id); render(); } },
  export: () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `calitracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  reset: () => {
    if (confirm('Erase all sessions, bands and progressions and start over? This cannot be undone.')) {
      S.resetState(); ui.drafts = {}; render();
    }
  },
  'timer-stop': stopTimer,
  'timer-cancel': closeTimer,
  'timer-discard': closeTimer,
  'timer-adj': (el) => { ui.timer.result = Math.max(0, ui.timer.result + Number(el.dataset.d)); renderTimer(); },
  'timer-log': () => {
    const t = ui.timer, d = draftFor(t.exId);
    d.value = t.result;
    closeTimer();
    if (t.result > 0) logAndCelebrate(t.exId, d);
    render();
  },
  'rest-add': () => { if (ui.rest) { ui.rest.end += 15000; renderRest(); } },
  'rest-close': () => { ui.rest = null; renderRest(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  // Any tap outside the band dropdown closes it.
  if (ui.bandMenu && !e.target.closest('.dd')) closeBandMenu();
  if (el) {
    const fn = actions[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el); }
    return;
  }
  // tap on the dimmed backdrop closes the sheet
  if (e.target.id === 'sheet') closeSheet();
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.hasAttribute('data-picker-search')) { ui.pickerQuery = t.value; applyPickerFilter(); return; }
  if (t.dataset.bind === 'value') draftFor(t.dataset.id).value = Math.max(0, Number(t.value) || 0);
  if (t.dataset.bind === 'kg') draftFor(t.dataset.id).addedKg = Math.max(0, Number(t.value) || 0);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.band) {
    const b = S.bandById(t.dataset.band);
    if (!b) return;
    const f = t.dataset.field;
    b[f] = ['widthMm', 'minKg', 'maxKg'].includes(f) ? Math.max(0, Number(t.value) || 0) : t.value;
    S.save(); render();
  }
  if (t.name === 'exId' && t.form?.id === 'pr-form') {
    const ex = S.exById(t.value);
    t.form.level.innerHTML = prLevelOptions(ex);
    t.form.querySelector('[data-pr-unit]').textContent = ex.kind === 'static' ? 'Hold (seconds)' : 'Reps';
    t.form.querySelector('[data-pr-tempo]').hidden = ex.kind !== 'reps';
    t.form.querySelector('[data-pr-bands]').hidden = ex.allowBands === false;
    t.form.querySelector('[data-pr-weight]').hidden = ex.allowWeight === false;
    if (ex.allowBands === false) t.form.band.value = '';
    if (ex.allowWeight === false) t.form.addedKg.value = '';
  }
  if (t.dataset.setting === 'restSeconds') { state.restSeconds = Math.max(0, Number(t.value) || 0); S.save(); }
  if (t.hasAttribute('data-import') && t.files?.[0]) {
    t.files[0].text().then((txt) => {
      try {
        const next = JSON.parse(txt);
        if (!S.isValidState(next)) throw new Error('not a CaliTracker backup');
        if (!confirm('Replace all current data with this backup?')) return;
        next.activeSessionId ??= null;
        S.replaceState(S.migrate(next)); ui.drafts = {}; render();
      } catch (err) { alert(`Could not import: ${err.message}`); }
    });
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'pr-form') {
    e.preventDefault();
    const f = new FormData(e.target);
    const value = Number(f.get('value'));
    if (!(value > 0)) { alert('Enter the hold time or reps.'); return; }
    const band = String(f.get('band') || '');
    S.addManualPR({
      exId: String(f.get('exId')),
      level: Number(f.get('level')) || 0,
      value,
      bands: band ? [band] : [],
      bandMode: f.get('bandMode') === 'resist' ? 'resist' : 'assist',
      addedKg: Number(f.get('addedKg')) || 0,
      tempo: TEMPOS[f.get('tempo')] ? String(f.get('tempo')) : null,
      date: new Date(`${f.get('date')}T12:00`).getTime() || Date.now(),
      note: String(f.get('note') || '').trim(),
    });
    ui.sheet = null;
    ui.tab = 'prs';
    render();
    return;
  }
  if (e.target.id !== 'ex-form') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const levels = String(f.get('levels')).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!levels.length) { alert('Add at least one progression level.'); return; }
  const data = {
    name: String(f.get('name')).trim() || 'Untitled',
    kind: f.get('kind') === 'reps' ? 'reps' : 'static',
    group: String(f.get('group')),
    equipment: EQUIPMENT[f.get('equipment')] ? String(f.get('equipment')) : 'none',
    allowBands: f.get('allowBands') === 'on',
    allowWeight: f.get('allowWeight') === 'on',
    goal: Math.max(1, Number(f.get('goal')) || 1),
    levels,
  };
  const id = e.target.dataset.id;
  let ex;
  if (id === 'new') {
    ex = { id: S.uid(), currentLevel: 0, archived: false, ...data };
    state.exercises.push(ex);
  } else {
    ex = S.exById(id);
    Object.assign(ex, data);
    ex.currentLevel = clamp(ex.currentLevel, 0, levels.length - 1);
    delete ui.drafts[ex.id];
  }
  S.save();
  // From the workout picker, a new exercise goes straight into the session.
  if (id === 'new' && ui.tab === 'workout') {
    if (!S.activeSession()) S.startSession();
    S.addExerciseToSession(ex.id); ui.sheet = null;
  }
  else ui.sheet = { type: 'ex', id: ex.id };
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (ui.timer) closeTimer(); else if (ui.bandMenu) closeBandMenu(); else if (ui.sheet) closeSheet(); }
  if (e.key === ' ' && ui.timer?.phase === 'hold') { e.preventDefault(); stopTimer(); }
});

setInterval(() => { updateTopbar(); if (ui.rest && !ui.rest.done) renderRest(); }, 500);

render();
