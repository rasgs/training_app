// UI: rendering + event handling. Plain ES modules, no build step.
import * as S from './store.js';
import { GROUPS, EQUIPMENT, TEMPOS } from './data.js';
import { parsePlan, formatPlan, parseWorkoutText } from './plan.js';

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
  pickerCollapsed: new Set(GROUPS), // collapsed groups in the add-exercise sheet (all folded at start)
  exCollapsed: new Set(),  // exercise cards folded in the workout view
  optsOpen: new Set(),     // exercise cards with 'More options' open
  lastDeleted: null,       // for undoing a swiped-away set
  skillsOpen: new Set(),  // expanded groups in Settings → Skills (all folded by default)
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
  return parts.join(' ');
}

const clusterTag = (set) => (Array.isArray(set.cluster) && set.cluster.length > 1
  ? `<span class="badge tempo" title="Cluster set">${set.cluster.join('+')}</span>` : '');
/** Parsed plan for an exercise in the active session, or null. */
const planOf = (exId) => parsePlan(S.planFor(exId));

/** Human label for a plan: "5 × 10", "4 × 15s", "3 × (4+3+3)". */
const planLabel = (p, ex) => {
  const u = ex.kind === 'static' ? 's' : '';
  return p.cluster ? `${p.sets} × (${p.parts.join('+')})${u}` : `${p.sets} × ${p.perSet}${u}`;
};

const tempoTag = (set) => (set.tempo && TEMPOS[set.tempo]
  ? `<span class="badge tempo">${TEMPOS[set.tempo]}</span>` : '');

const equipBadge = (ex) => (ex.equipment && ex.equipment !== 'none'
  ? `<span class="badge">${ex.equipment === 'rings' ? '◯◯' : '━'} ${EQUIPMENT[ex.equipment]}</span>` : '');

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
  // Browsers only allow vibration after the user has tapped the page.
  if (navigator.userActivation?.hasBeenActive ?? true) navigator.vibrate?.(times > 1 ? [80, 60, 80] : 60);
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
          bandMode: 'assist',
          value: prev.value,
          addedKg: prev.level === ex.currentLevel ? prev.addedKg || 0 : 0,
          tempo: prev.tempo || null,
        }
      : { level: ex.currentLevel, bands: [], bandMode: 'assist', value: ex.kind === 'static' ? 10 : 5, addedKg: 0, tempo: null };
  }
  const d = ui.drafts[exId];
  d.level = clamp(d.level, 0, ex.levels.length - 1);
  if (!d.planApplied) {
    const p = planOf(exId);
    if (p) d.value = p.perSet;
    d.planApplied = true;
  }
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
    ${ui.rest || state.restOn === false ? '' : `<div class="row" style="justify-content:flex-end;margin-bottom:10px">
      <button class="btn sm ghost" data-act="rest-start">⏱ Rest timer ${fmtClock(Number(state.restSeconds ?? 90))}</button></div>`}
    ${cards || '<div class="empty">Add the first exercise of today\'s session.</div>'}
    <div class="stack" style="margin-top:14px">
      <button class="btn block big" data-act="open-picker">+ Add exercise</button>
      <div class="grid2">
        <button class="btn ghost" data-act="wk-from-session">Save as workout</button>
        <button class="btn ghost" data-act="finish-session">Finish session</button>
      </div>
    </div>`;
}

function viewWorkoutIdle() {
  const active = state.exercises.filter((e) => !e.archived);
  const ready = active.map((ex) => ({ ex, r: S.readiness(ex) })).filter((x) => x.r.ready);
  const last = [...state.sessions].filter((x) => x.endedAt).sort((a, b) => b.startedAt - a.startedAt)[0];
  return `
    <div class="card hero">
      <p class="big-title">Time to <em>train</em>.</p>
      <p class="muted small" style="margin:0 0 16px">Pick an exercise and log your sets. You'll get a nudge when it's time to move up a level.</p>
      <button class="btn primary block big" data-act="start-session">Start session</button>
    </div>
    <div class="spread view-head" style="margin-top:22px"><h2>Workouts</h2><button class="btn sm" data-act="wk-edit" data-id="new">+ New</button></div>
    ${state.workouts.length ? state.workouts.map((w) => `
      <div class="card wk-card">
        <div class="spread">
          <h3>${esc(w.name)}</h3>
          <div class="row">
            <button class="icon-btn plain" data-act="wk-edit" data-id="${w.id}" aria-label="Edit ${esc(w.name)}">✎</button>
            <button class="btn sm primary" data-act="wk-start" data-id="${w.id}">Start</button>
          </div>
        </div>
        <div class="small muted wk-items">${w.items.map((it) => {
          const ex = S.exById(it.exId);
          return ex ? `<span>${esc(ex.name)}${it.plan ? ` <b>${esc(formatPlan(parsePlan(it.plan), ex.kind) || it.plan)}</b>` : ''}</span>` : '';
        }).filter(Boolean).join('')}</div>
      </div>`).join('')
      : `<div class="empty small">Save a workout you repeat, like<br><code>Pull-up 3x8 · Dip 3x10 · Front lever 4x10s</code><br>and start it with one tap.</div>`}
    ${ready.length ? `<h2>Ready to move up</h2>${ready.map(({ ex }) => `
      <div class="card tap" data-act="open-ex" data-id="${ex.id}">
        <div class="spread"><h3>${esc(ex.name)}</h3><span class="badge ready">Move up</span></div>
        <div class="small muted" style="margin-top:4px">${esc(ex.levels[ex.currentLevel])} → <b style="color:var(--text)">${esc(ex.levels[ex.currentLevel + 1])}</b></div>
      </div>`).join('')}` : ''}
    ${last ? `<h2>Last session</h2>${sessionCard(last, true)}` : ''}`;
}

function exDetail(ex, session) {
  const d = draftFor(ex.id);
  const sets = session.sets.filter((x) => x.exId === ex.id);
  const prev = S.lastSetsFor(ex.id, session.id);
  const prIds = new Set(S.prsFor(ex.id).events.map((ev) => ev.entry.id));
  const r = S.readiness(ex);
  const nextIsUp = r.ready && d.level === ex.currentLevel;
  const bandsSorted = [...state.bands].sort((a, b) => (a.widthMm || 0) - (b.widthMm || 0));
  const idx = session.exerciseIds.indexOf(ex.id);
  const last = session.exerciseIds.length - 1;
  const plan = planOf(ex.id);
  const planDone = sets.length;
  const optsSummary = [d.tempo ? TEMPOS[d.tempo] : '', ex.equipment && ex.equipment !== 'none' ? EQUIPMENT[ex.equipment] : '']
    .filter(Boolean).join(' · ');

  return `
  <div class="ex-detail">
    <div class="sheet-head">
      <div><h2>${esc(ex.name)}</h2><div class="small muted">${ex.kind === 'static' ? 'Hold' : 'Reps'} · goal ${fmtVal(ex, ex.goal)}</div></div>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
    </div>
    <div class="plan-row">
      ${plan
        ? `<button class="plan-chip" data-act="plan-edit" data-id="${ex.id}" aria-label="Change sets and reps">${esc(planLabel(plan, ex))} <span class="muted">✎</span></button>`
        : `<button class="btn sm ghost" data-act="plan-edit" data-id="${ex.id}">+ Sets × ${ex.kind === 'static' ? 'seconds' : 'reps'}</button>`}
      ${plan ? `<div class="plan-progress" aria-label="${Math.min(planDone, plan.sets)} of ${plan.sets} sets done">
        ${Array.from({ length: plan.sets }, (_, i) => `<i class="${i < planDone ? 'done' : i === planDone ? 'next' : ''}"></i>`).join('')}
        <span class="small ${planDone >= plan.sets ? '' : 'muted'}">${planDone >= plan.sets ? 'Done ✓' : `Set ${planDone + 1} of ${plan.sets}`}</span>
      </div>` : ''}
    </div>
    <label class="field level-field">
      <span>Progression level</span>
      <select class="input level-select" data-bind="level" data-id="${ex.id}" aria-label="Progression level">
        ${ex.levels.map((name, i) => `<option value="${i}" ${i === d.level ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
    </label>
    ${nextIsUp ? `<div class="hint"><span class="badge ready">Goal hit ${r.hits}×</span> Try <b style="color:var(--text)">${esc(ex.levels[d.level + 1])}</b>
      <button class="btn sm" data-act="lvl" data-id="${ex.id}" data-d="1">Move up</button></div>` : ''}

    ${ex.allowBands !== false || ex.allowWeight !== false ? `<div class="section">
      ${ex.allowBands !== false ? `<div class="label" style="margin-bottom:6px">Resistance band</div>
      <div class="band-ctl">
        ${bandDropdown(ex, d, bandsSorted)}
      </div>` : ''}
      ${ex.allowWeight !== false ? `
        <label class="weight-row ${ex.allowBands !== false ? 'below' : ''}">
          <span class="label">Added weight</span>
          <span class="kg-input"><input class="input num" type="number" inputmode="decimal" min="0" step="0.5" value="${esc(d.addedKg || '')}" placeholder="0" data-bind="kg" data-id="${ex.id}"><span class="muted">kg</span></span>
        </label>` : ''}
    </div>` : ''}

    <details class="ex-opts" data-opts="${ex.id}" ${ui.optsOpen.has(ex.id) ? 'open' : ''}>
      <summary><span>More options</span>${optsSummary ? `<span class="small">${esc(optsSummary)}</span>` : ''}</summary>
      ${ex.kind === 'reps' ? `
        <div class="label" style="margin:10px 0 6px">Tempo</div>
        <div class="seg seg-full" role="group" aria-label="Tempo">
          <button data-act="tempo" data-id="${ex.id}" data-t="" aria-pressed="${!d.tempo}">Standard</button>
          ${Object.entries(TEMPOS).map(([k, label]) => `
            <button data-act="tempo" data-id="${ex.id}" data-t="${k}" aria-pressed="${d.tempo === k}">${label}</button>`).join('')}
        </div>` : ''}
      <div class="label" style="margin:10px 0 6px">Equipment</div>
      <div class="seg seg-full" role="group" aria-label="Equipment">
        ${Object.entries(EQUIPMENT).map(([k, label]) => `
          <button data-act="equip" data-id="${ex.id}" data-e="${k}" aria-pressed="${(ex.equipment || 'none') === k}">${label}</button>`).join('')}
      </div>
    </details>

    <div class="label" style="margin:14px 0 6px">Log a custom set</div>
    <div class="value-row">
      <div class="counter">
        <button data-act="val" data-id="${ex.id}" data-d="-1" aria-label="Decrease">−</button>
        <div>
          <input class="num" type="number" inputmode="numeric" min="0" value="${esc(d.value)}" data-bind="value" data-id="${ex.id}" aria-label="${ex.kind === 'static' ? 'Hold seconds' : 'Reps'}">
          <span class="unit">${ex.kind === 'static' ? 'seconds held' : 'reps'}</span>
        </div>
        <button data-act="val" data-id="${ex.id}" data-d="1" aria-label="Increase">+</button>
      </div>
      ${plan?.cluster
        ? `<button class="btn hold-btn" data-act="cluster" data-id="${ex.id}" title="Run a ${plan.parts.join('+')} cluster with ${plan.clusterRest}s rests">▶ Cluster</button>`
        : ex.kind === 'static' ? `<button class="btn hold-btn" data-act="hold" data-id="${ex.id}">▶ Timer</button>` : ''}
    </div>
    ${plan?.cluster ? `<div class="small muted" style="margin-top:6px">Cluster ${plan.parts.join(' + ')}${ex.kind === 'static' ? 's' : ''} · ${plan.clusterRest}s between</div>` : ''}
    <button class="btn primary block big" style="margin-top:10px" data-act="log" data-id="${ex.id}">Log set</button>

    ${sets.length ? `<ul class="sets">${sets.map((x, i) => setRow(ex, x, session.id, i + 1, prIds)).join('')}</ul>
      <div class="small muted swipe-hint">Swipe a set left to delete it</div>` : ''}

    ${prev ? `<div class="hint">${lastSessionLine(ex, prev)}</div>` : ''}
    <div class="grid3 detail-tools">
      <button class="btn ghost" data-act="ex-move" data-id="${ex.id}" data-d="-1" ${idx <= 0 ? 'disabled' : ''}>↑ Move up</button>
      <button class="btn ghost" data-act="ex-move" data-id="${ex.id}" data-d="1" ${idx >= last ? 'disabled' : ''}>↓ Move down</button>
      <button class="btn danger" data-act="remove-ex" data-id="${ex.id}">Remove</button>
    </div>
  </div>`;
}

/**
 * Compact exercise row (StrongLifts-style): name + plan summary, then one circle per set.
 * Tap an open circle to complete it at the target; tap a done circle to take off one rep
 * (or second); at zero it's removed (with Undo). "+" adds a set. "›" opens the details.
 */
function exCard(ex, session) {
  const d = draftFor(ex.id);
  const sets = session.sets.filter((x) => x.exId === ex.id);
  const prev = S.lastSetsFor(ex.id, session.id);
  const r = S.readiness(ex);
  const plan = planOf(ex.id);
  const target = plan ? plan.perSet : Number(d.value) || 1;
  const slots = Math.max(plan ? plan.sets : 0, sets.length);
  const u = ex.kind === 'static' ? 's' : '';
  const unitWord = ex.kind === 'static' ? 'seconds' : 'reps';
  const chosen = ex.allowBands !== false ? d.bands.map(S.bandById).filter(Boolean) : [];
  const sub = [
    esc(ex.levels[d.level]),
    chosen.length ? `<span class="band-inline">${chosen.map((b) => swatch(b)).join('')}</span>` : '',
    ex.allowWeight !== false && d.addedKg ? `+${esc(d.addedKg)} kg` : '',
    ex.kind === 'reps' && d.tempo ? esc(TEMPOS[d.tempo].toLowerCase()) : '',
  ].filter(Boolean).join(' · ');
  const nextIdx = sets.length;

  const circles = Array.from({ length: slots }, (_, i) => {
    const set = sets[i];
    if (set) {
      const short = set.value < target;
      return `<button class="set-circle done ${short ? 'short' : ''}" data-act="set-edit" data-session="${session.id}" data-set="${set.id}"
        aria-label="Set ${i + 1}: ${set.value} ${unitWord}. Tap to edit">${esc(set.value)}${u}</button>`;
    }
    return `<button class="set-circle ${i === nextIdx ? 'next' : ''}" data-act="set-do" data-id="${ex.id}"
      aria-label="Set ${i + 1}: complete ${target} ${unitWord}">${target}${u}</button>`;
  }).join('');

  return `
  <div class="card ex-row">
    <button class="ex-row-head" data-act="ex-detail" data-id="${ex.id}" aria-label="${esc(ex.name)} details">
      <span class="ex-row-name"><span class="h3">${esc(ex.name)}</span><span class="small muted">${sub}</span></span>
      <span class="ex-row-plan">${plan ? esc(planLabel(plan, ex)) : '<span class="muted">No plan</span>'}<span class="chev">›</span></span>
    </button>
    <div class="set-circles">
      ${circles}
      <button class="set-circle add" data-act="set-add" data-id="${ex.id}" aria-label="Add a set of ${target} ${unitWord}">+</button>
    </div>
    ${r.ready && d.level === ex.currentLevel ? `<div class="hint"><span class="badge ready">Goal hit ${r.hits}×</span>
      Ready for <b style="color:var(--text)">${esc(ex.levels[d.level + 1])}</b>
      <button class="btn sm" data-act="lvl" data-id="${ex.id}" data-d="1">Move up</button></div>` : ''}
    ${prev ? `<div class="hint">${lastSessionLine(ex, prev)}</div>` : ''}
  </div>`;
}

/** "Last session (Sun 22 Nov): Pull-up, slow · 6 + 5 reps" */
function lastSessionLine(ex, prev) {
  const groups = [];
  for (const x of prev.sets) {
    const key = `${x.level}|${x.tempo || ''}|${x.cluster ? 'c' : ''}|${x.bands.join(',')}|${x.addedKg || 0}`;
    const g = groups.at(-1);
    if (g && g.key === key) g.vals.push(x.value);
    else groups.push({ key, set: x, vals: [x.value] });
  }
  const unitWord = ex.kind === 'static' ? 's' : ' reps';
  const body = groups.map(({ set, vals }) => {
    const bits = [esc(set.levelName)];
    if (set.tempo) bits.push(esc(TEMPOS[set.tempo].toLowerCase()));
    const bands = set.bands.map(S.bandById).filter(Boolean);
    if (bands.length) bits.push(`${bands.map((b) => esc(b.name.toLowerCase())).join(' + ')} band`);
    if (set.addedKg) bits.push(`+${esc(set.addedKg)} kg`);
    const v = set.cluster ? vals.map((n, i) => (i === 0 ? `${n} (${set.cluster.join('+')})` : n)) : vals;
    return `${bits.join(', ')} · ${v.join(' + ')}${unitWord}`;
  }).join('; ');
  return `<span class="label">Last session (${esc(fmtDate(prev.session.startedAt))})</span> <span>${body}</span>`;
}

/** One logged set. Swipe left (touch or mouse) to delete; see initSwipe(). */
function setRow(ex, x, sessionId, n, prIds = new Set()) {
  const load = loadInline(x);
  return `
    <li class="swipe" data-act="set-edit" data-session="${sessionId}" data-set="${x.id}" tabindex="0" aria-label="Edit set ${n}">
      <div class="swipe-bg" aria-hidden="true">Delete</div>
      <div class="swipe-fg">
        <span class="s-n">${n}</span>
        <span><span class="small">${esc(x.levelName)}</span> ${tempoTag(x)}${clusterTag(x)}${load ? `<br>${load}` : ''}</span>
        <span class="s-v">${esc(x.value)}<small>${unit(ex)}</small>${prIds.has(x.id) ? '<span class="s-pr">PR</span>' : ''}</span>
      </div>
    </li>`;
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
    const key = `${x.level}|${x.tempo || ''}|${x.cluster ? 'c' : ''}|${loadInline(x)}`;
    const g = groups.at(-1);
    if (g && g.key === key) g.vals.push(x.value);
    else groups.push({ key, level: x.level, set: x, vals: [x.value] });
  }
  return groups.map((g) => `<span class="row" style="gap:5px"><span class="small">${esc(g.set.levelName)}</span>${tempoTag(g.set)}${clusterTag(g.set)}
    <span class="num" style="color:var(--text)">${g.vals.map((v) => esc(fmtVal(ex, v))).join(' / ')}</span>${loadInline(g.set)}</span>`).join('<span class="muted">·</span>');
}

// ---------- Skills ----------
function viewSkills() {
  const list = state.exercises.filter((e) => !e.archived);
  const archived = state.exercises.filter((e) => e.archived);
  const groups = GROUPS.map((g) => ({ g, items: list.filter((e) => (e.group || 'Other') === g) })).filter((x) => x.items.length);
  return `
    <div class="spread view-head"><h2>Progressions</h2><button class="btn sm" data-act="edit-ex" data-id="new">+ New</button></div>
    ${groups.map(({ g, items }) => {
      const open = ui.skillsOpen.has(g);
      const ready = items.filter((ex) => S.readiness(ex).ready).length;
      return `
      <section class="skill-group ${open ? 'open' : ''}">
        <button class="pick-head" data-act="skills-group" data-g="${g}" aria-expanded="${open}">
          <span class="dot g-${g.toLowerCase()}"></span><span class="label">${esc(g)}</span>
          ${ready ? `<span class="badge ready">${ready} ready</span>` : ''}
          <span class="small muted pick-count">${items.length}</span><span class="pick-chev">▾</span>
        </button>
        ${open ? `<div class="skill-group-body">${items.map(skillCard).join('')}</div>` : ''}
      </section>`;
    }).join('')}
    ${archived.length ? `
      <button class="btn ghost block" style="margin-top:16px" data-act="toggle-archived">${ui.showArchived ? 'Hide' : 'Show'} archived (${archived.length})</button>
      ${ui.showArchived ? archived.map(skillCard).join('') : ''}` : ''}`;
}

function skillCard(ex) {
  const r = S.readiness(ex);
  const top = S.prsFor(ex.id).top;
  return `
    <div class="card tap" data-act="open-ex" data-id="${ex.id}">
      <div class="spread">
        <div>
          <h3>${esc(ex.name)}</h3>
          <div class="small muted">${ex.levels.length} levels${ex.equipment && ex.equipment !== 'none' ? ` · ${EQUIPMENT[ex.equipment]}` : ''}</div>
        </div>
        ${r.ready ? '<span class="badge ready">Move up</span>' : r.isLast && r.hits >= 2 ? '<span class="badge ready">Mastered</span>' : `<span class="badge ${ex.kind === 'static' ? 'kind-static' : ''}">${ex.kind === 'static' ? 'Hold' : 'Reps'}</span>`}
      </div>
      <div class="skill-top small">
        ${top
          ? `<span class="muted">Highest reached:</span> <b>${esc(top.levelName)}</b>${top.tempo ? ` ${tempoTag(top)}` : ''}
             <span class="skill-pr">${esc(fmtVal(ex, top.value))}${S.isAssisted(top) ? ' <span class="muted">· band</span>' : ''}</span>`
          : '<span class="muted">Not trained yet</span>'}
      </div>
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
    <div class="label">Progressions · tap the one you're working on</div>
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
            <span><span class="small">${esc(x.levelName)}</span> ${tempoTag(x)}${clusterTag(x)}<br>${loadInline(x)}</span>
            <span class="s-v">${esc(x.value)}<small>${unit(ex)}</small></span></li>`).join('')}
        </ul>
      </div>`).join('') : '<div class="empty small">No sets logged yet.</div>'}`;
}

/** Trim a progression name to fit a chart column (about `max` characters). */
const shortName = (name, max) => (name.length <= max ? name : `${name.slice(0, Math.max(3, Math.floor(max) - 1))}…`);

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
      <text class="lvl-label" x="${(x0 + 4).toFixed(1)}" y="${pt - 4}">${esc(shortName(ex.levels[s.level] || '', (x1 - x0) / 5.5))}</text>`;
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
      <span><span class="dot" style="background:var(--accent)"></span>no band</span>
      <span><span class="dot" style="background:var(--muted)"></span>dot = assisting band color</span>
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
      <label class="field"><span data-goal-label>${ex.kind === 'reps' ? 'Reps to level up' : 'Hold time to level up (seconds)'}</span>
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
            <span><b>${esc(ex.name)}</b><br><span class="small muted">${esc(ex.levels[ex.currentLevel])}${ex.equipment && ex.equipment !== 'none' ? ` · ${EQUIPMENT[ex.equipment]}` : ''}</span></span>
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
          <span class="pr-star ${ev.type === 'level' ? 'lvl' : ''}" title="${ev.type === 'level' ? 'New progression' : 'PR'}">${ev.type === 'level' ? '▲' : '★'}</span>
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
          <span class="small muted">${esc(top.levelName)}${top.tempo ? ` · ${esc(TEMPOS[top.tempo].toLowerCase())}` : ''}${S.isAssisted(top) ? ' · band' : ''}</span></span>
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
    <span>${esc(e.levelName)} ${tempoTag(e)}${clusterTag(e)}<br><span class="small muted">${fmtDay(e.date)}${e.manual ? ' · manual' : ''}${e.note ? ` · ${esc(e.note)}` : ''}</span></span>
    <span class="row" style="justify-content:flex-end">${loadInline(e)}<span class="pl-v">${esc(fmtVal(ex, e.value))}</span></span>
    ${e.manual ? `<button class="icon-btn plain" data-act="pr-del" data-id="${e.id}" aria-label="Delete manual PR">×</button>` : '<span></span>'}
  </li>`;
}

function prLevelOptions(ex, selected = ex.currentLevel) {
  return ex.levels.map((name, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(name)}</option>`).join('');
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
      <div data-pr-bands ${ex.allowBands === false ? 'hidden' : ''}>
        <label class="field"><span>Band</span>
          <select class="input" name="band">
            <option value="">No band</option>
            ${bands.map((b) => `<option value="${b.id}">${esc(b.name)} · ${esc(b.widthMm)} mm</option>`).join('')}
          </select></label>
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
      <div class="small muted">${esc(top.levelName)}</div>
    </div>`;
  }).join('');
  return `
    <div class="card tap" data-act="open-session" data-id="${s.id}">
      <div class="spread">
        <b>${fmtDate(s.startedAt)}</b>
        <span class="small muted">${s.sets.length} set${s.sets.length === 1 ? '' : 's'}${s.endedAt ? ` · ${fmtDur(s.endedAt - s.startedAt)}` : ' · in progress'} ›</span>
      </div>
      <div style="margin-top:8px">${lines}</div>
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

// ---------- Edit a logged set (long-press) ----------
function sheetSetEdit(key) {
  const [sessionId, setId] = String(key).split('|');
  const sess = state.sessions.find((x) => x.id === sessionId);
  const set = sess?.sets.find((x) => x.id === setId);
  const ex = set && S.exById(set.exId);
  if (!ex) return '';
  const n = sess.sets.filter((x) => x.exId === ex.id).indexOf(set) + 1;
  const bands = [...state.bands].sort((a, b) => (a.widthMm || 0) - (b.widthMm || 0));
  const unitWord = ex.kind === 'static' ? 'Seconds' : 'Reps';
  return `
    <div class="sheet-head">
      <div><h2>${esc(ex.name)}</h2><div class="small muted">Set ${n} · ${esc(fmtDate(sess.startedAt))}</div></div>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
    </div>
    <form class="stack" id="set-form" data-session="${sessionId}" data-set="${setId}">
      <div class="field"><span>${unitWord}</span>
        <div class="counter">
          <button type="button" data-act="pf-adj" data-d="-1" aria-label="Less">−</button>
          <input class="num" type="number" inputmode="numeric" min="0" name="value" value="${esc(set.value)}" aria-label="${unitWord}">
          <button type="button" data-act="pf-adj" data-d="1" aria-label="More">+</button>
        </div>
      </div>
      ${set.cluster ? `<p class="small muted" style="margin:0">Cluster ${set.cluster.join(' + ')}. Changing the total makes it a normal set.</p>` : ''}
      <label class="field"><span>Progression level</span>
        <select class="input" name="level">${ex.levels.map((name, i) => `<option value="${i}" ${i === set.level ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
      ${ex.allowBands !== false || set.bands.length ? `
        <div class="field"><span>Resistance band</span>
          <div class="band-checks">${bands.map((b) => `
            <label class="band-check"><input type="checkbox" name="band" value="${b.id}" ${set.bands.includes(b.id) ? 'checked' : ''}>${swatch(b)}<span>${esc(b.name)}</span></label>`).join('')}
          </div></div>` : ''}
      ${ex.allowWeight !== false || set.addedKg ? `
        <label class="weight-row"><span class="label">Added weight</span>
          <span class="kg-input"><input class="input num" type="number" name="addedKg" min="0" step="0.5" inputmode="decimal" value="${esc(set.addedKg || '')}" placeholder="0"><span class="muted">kg</span></span></label>` : ''}
      ${ex.kind === 'reps' ? `
        <label class="field"><span>Tempo</span>
          <select class="input" name="tempo"><option value="">Standard</option>
            ${Object.entries(TEMPOS).map(([k, label]) => `<option value="${k}" ${set.tempo === k ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>` : ''}
      <div class="grid2">
        <button class="btn danger big" type="button" data-act="set-edit-delete" data-session="${sessionId}" data-set="${setId}">Delete set</button>
        <button class="btn primary big" type="submit">Save</button>
      </div>
    </form>`;
}

// ---------- Sets × reps popup ----------
/** Starting values: the current plan, else the one used last session, else 3 × goal. */
function planDefaults(ex) {
  const p = planOf(ex.id) || parsePlan(
    [...state.sessions].sort((a, b) => b.startedAt - a.startedAt)
      .find((x) => x.id !== state.activeSessionId && x.plans?.[ex.id])?.plans[ex.id]);
  if (p) return { sets: p.sets, value: p.cluster ? p.perSet : p.parts[0], cluster: p.cluster, parts: p.cluster ? p.parts.join('+') : '', rest: p.clusterRest || 15 };
  const value = ex.kind === 'static' ? Math.min(ex.goal, 30) : Math.min(ex.goal, 10);
  return { sets: 3, value, cluster: false, parts: '', rest: 15 };
}

function sheetPlan(exId) {
  const ex = S.exById(exId);
  if (!ex) return '';
  const v = planDefaults(ex);
  const unitWord = ex.kind === 'static' ? 'Seconds' : 'Reps';
  const stepper = (field, value, label) => `
    <div class="field"><span>${label}</span>
      <div class="counter">
        <button type="button" data-act="pf-adj" data-f="${field}" data-d="-1" aria-label="Fewer ${label.toLowerCase()}">−</button>
        <input class="num" type="number" inputmode="numeric" min="1" name="${field}" value="${value}" aria-label="${label}">
        <button type="button" data-act="pf-adj" data-f="${field}" data-d="1" aria-label="More ${label.toLowerCase()}">+</button>
      </div>
    </div>`;
  const d = draftFor(ex.id);
  const sess = S.activeSession();
  const prev = S.lastSetsFor(ex.id, sess?.id);
  const bands = [...state.bands].sort((a, b) => (a.widthMm || 0) - (b.widthMm || 0));
  return `
    <div class="sheet-head">
      <h2>${esc(ex.name)}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
    </div>
    ${prev ? `<div class="hint last-hint">${lastSessionLine(ex, prev)}</div>` : `<p class="small muted" style="margin:0 0 10px">First time logging ${esc(ex.name)}.</p>`}
    <form class="stack" id="plan-form" data-id="${ex.id}">
      <label class="field"><span>Progression level</span>
        <select class="input level-select" name="level">${ex.levels.map((name, i) => `<option value="${i}" ${i === d.level ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
      <div class="grid2">${stepper('sets', v.sets, 'Sets')}${stepper('value', v.value, unitWord)}</div>
      <label class="toggle"><input type="checkbox" name="cluster" ${v.cluster ? 'checked' : ''} data-pf-cluster><span>Cluster set</span></label>
      <div class="grid2" data-pf-cluster-fields ${v.cluster ? '' : 'hidden'}>
        <label class="field"><span>Split each set</span>
          <input class="input num" name="parts" value="${esc(v.parts)}" placeholder="${ex.kind === 'static' ? '5+5+5' : '4+3+3'}" inputmode="text" autocomplete="off"></label>
        <label class="field"><span>Rest between (s)</span>
          <input class="input num" name="rest" type="number" min="0" step="5" inputmode="numeric" value="${v.rest}"></label>
      </div>
      ${ex.allowBands !== false ? `
        <div class="field"><span>Resistance band</span>
          <div class="band-checks">${bands.map((b) => `
            <label class="band-check"><input type="checkbox" name="band" value="${b.id}" ${d.bands.includes(b.id) ? 'checked' : ''}>${swatch(b)}<span>${esc(b.name)}</span></label>`).join('')}
          </div></div>` : ''}
      ${ex.allowWeight !== false ? `
        <label class="weight-row"><span class="label">Added weight</span>
          <span class="kg-input"><input class="input num" type="number" name="addedKg" min="0" step="0.5" inputmode="decimal" value="${esc(d.addedKg || '')}" placeholder="0"><span class="muted">kg</span></span></label>` : ''}
      ${ex.kind === 'reps' ? `
        <div class="field"><span>Tempo</span>
          <div class="seg seg-radio" role="radiogroup" aria-label="Tempo">
            <label><input type="radio" name="tempo" value="" ${!d.tempo ? 'checked' : ''}>Standard</label>
            ${Object.entries(TEMPOS).map(([k, label]) => `<label><input type="radio" name="tempo" value="${k}" ${d.tempo === k ? 'checked' : ''}>${label}</label>`).join('')}
          </div></div>` : ''}
      <div class="field"><span>Equipment</span>
        <div class="seg seg-radio" role="radiogroup" aria-label="Equipment">
          ${Object.entries(EQUIPMENT).map(([k, label]) => `<label><input type="radio" name="equipment" value="${k}" ${(ex.equipment || 'none') === k ? 'checked' : ''}>${label}</label>`).join('')}
        </div></div>
      <div class="grid2">
        <button class="btn ghost big" type="button" data-act="plan-clear" data-id="${ex.id}">No plan</button>
        <button class="btn primary big" type="submit">Save</button>
      </div>
    </form>`;
}

// ---------- Saved workout editor ----------
const workoutText = (items) => items.map((it) => {
  const ex = S.exById(it.exId);
  if (!ex) return '';
  const p = parsePlan(it.plan);
  return `${ex.name}${it.plan ? ` ${p ? formatPlan(p, ex.kind) : it.plan}` : ''}`;
}).filter(Boolean).join('\n');

function sheetWorkout(id) {
  const w = id && id !== 'new' && id !== 'session' ? state.workouts.find((x) => x.id === id) : null;
  const text = w ? workoutText(w.items) : id === 'session' ? workoutText(S.sessionAsItems()) : '';
  return `
    <div class="sheet-head">
      <h2>${w ? 'Edit workout' : 'New workout'}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
    </div>
    <form class="stack" id="wk-form" data-id="${w ? w.id : ''}">
      <label class="field"><span>Name</span>
        <input class="input" name="name" required value="${esc(w?.name || '')}" placeholder="e.g. Pull day"></label>
      <label class="field"><span>One exercise per line, with sets x reps</span>
        <textarea class="input wk-text" name="text" data-wk-text spellcheck="false" autocapitalize="off"
          placeholder="Pull-up 3x8&#10;Front lever 4x10s&#10;Dip 3x(4+3+3)">${esc(text)}</textarea></label>
      <p class="small muted" style="margin:0">Holds are in seconds. Clusters: <code>3x(4+3+3)</code>, with a custom rest <code>3x(4+3+3)/20s</code>.</p>
      <ul class="wk-preview" data-wk-preview></ul>
      <div class="grid2">
        <button class="btn primary big" type="submit" name="go" value="save">Save</button>
        <button class="btn big" type="submit" name="go" value="start">${S.activeSession() ? 'Save & add' : 'Save & start'}</button>
      </div>
      ${w ? `<button class="btn danger block" type="button" data-act="wk-delete" data-id="${w.id}">Delete workout</button>` : ''}
    </form>`;
}

function updateWorkoutPreview() {
  const ta = document.querySelector('[data-wk-text]');
  const ul = document.querySelector('[data-wk-preview]');
  if (!ta || !ul) return;
  const rows = parseWorkoutText(ta.value, state.exercises.filter((e) => !e.archived));
  ul.innerHTML = rows.map((r) => r.error
    ? `<li class="bad">⚠ ${esc(r.error)}</li>`
    : `<li><span>${esc(r.ex.name)}</span><b>${r.plan ? esc(formatPlan(r.plan, r.ex.kind)) : '<span class="muted">no plan</span>'}</b></li>`).join('');
}

/** Add a saved workout's exercises (and plans) to the running session. */
function addWorkoutToSession(w) {
  const s = S.activeSession();
  for (const it of w.items) {
    if (!S.exById(it.exId)) continue;
    S.addExerciseToSession(it.exId);
    if (it.plan && !S.planFor(it.exId)) S.setPlan(it.exId, it.plan);
    delete ui.drafts[it.exId];
  }
  return s;
}

// ---------- Session details ----------
function sheetSession(s) {
  const exIds = [...new Set([...s.exerciseIds, ...s.sets.map((x) => x.exId)])];
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const blocks = exIds.map((id) => {
    const ex = S.exById(id);
    const sets = s.sets.filter((x) => x.exId === id);
    if (!ex || !sets.length) return '';
    const prIds = new Set(S.prsFor(ex.id).events.map((ev) => ev.entry.id));
    return `
      <div class="card">
        <div class="spread"><h3>${esc(ex.name)}</h3><span class="small muted">${sets.length} set${sets.length === 1 ? '' : 's'}</span></div>
        <ul class="sets">${sets.map((x, i) => setRow(ex, x, s.id, i + 1, prIds)).join('')}</ul>
      </div>`;
  }).join('');
  return `
    <div class="sheet-head">
      <h2>${fmtDate(s.startedAt)}</h2>
      <button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button>
    </div>
    <p class="small muted" style="margin-top:0">${fmtTime(s.startedAt)}${s.endedAt ? `–${fmtTime(s.endedAt)} · ${fmtDur(s.endedAt - s.startedAt)}` : ' · in progress'}
      · ${s.sets.length} set${s.sets.length === 1 ? '' : 's'}. Swipe a set left to delete it.</p>
    ${blocks || '<div class="empty small">No sets in this session.</div>'}
    <button class="btn danger block" style="margin-top:14px" data-act="del-session" data-id="${s.id}">Delete session</button>`;
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
      <label class="toggle"><input type="checkbox" data-setting="restOn" ${state.restOn !== false ? 'checked' : ''}><span>Rest timer after each set</span></label>
      <label class="field" ${state.restOn === false ? 'hidden' : ''}><span>Rest time (seconds)</span>
        <input class="input num" type="number" min="5" step="15" inputmode="numeric" value="${esc(state.restSeconds ?? 90)}" data-setting="restSeconds"></label>
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
  if (type === 'workout') body = sheetWorkout(id);
  if (type === 'plan') body = sheetPlan(id);
  if (type === 'setedit') body = sheetSetEdit(id) || (ui.sheet = null, '');
  if (type === 'exdetail') {
    const sess = S.activeSession(), ex = S.exById(id);
    if (!sess || !ex || !sess.exerciseIds.includes(id)) { ui.sheet = null; return renderSheet(); }
    body = exDetail(ex, sess);
  }
  if (type === 'session') {
    const sess = state.sessions.find((x) => x.id === id);
    if (!sess) { ui.sheet = null; return renderSheet(); }
    body = sheetSession(sess);
  }
  const scroll = wrap.querySelector('.sheet')?.scrollTop || 0;
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${body}</div>`;
  wrap.hidden = false;
  wrap.querySelector('.sheet').scrollTop = scroll;
  if (type === 'picker') applyPickerFilter();
  if (type === 'workout') updateWorkoutPreview();
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
  const p = planOf(exId);
  ui.timer = { exId, phase: 'ready', t0: performance.now() + COUNTDOWN * 1000, start: 0, elapsed: 0, hit: false,
    goal: p && !p.cluster ? p.perSet : S.exById(exId).goal };
  holdWake(true);
  renderTimer();
  tick();
}

function tick() {
  if (holdCheck()) ui.timer.raf = requestAnimationFrame(tick);
}

/** Advance the hold timer; returns false once there's nothing left to animate. */
function holdCheck() {
  const t = ui.timer;
  if (!t || t.phase === 'done') return false;
  const now = performance.now();
  const ex = S.exById(t.exId);
  if (t.phase === 'ready' && now >= t.t0) {
    t.phase = 'hold'; t.start = t.t0; beep(990, 0.18);
    renderTimer();
  }
  if (t.phase === 'hold') {
    t.elapsed = (now - t.start) / 1000;
    if (!t.hit && t.elapsed >= t.goal) { t.hit = true; beep(1320, 0.12, 2); $('#timer').classList.add('hit'); }
  }
  updateTimerDigits();
  return true;
}

function updateTimerDigits() {
  const t = ui.timer, ex = S.exById(t.exId);
  const el = $('#timer .t-digits');
  if (!el) return;
  if (t.phase === 'ready') el.textContent = Math.ceil((t.t0 - performance.now()) / 1000);
  else if (t.phase === 'hold') {
    el.textContent = t.elapsed < 60 ? t.elapsed.toFixed(1) : fmtClock(t.elapsed);
    const bar = $('#timer .goalbar > b');
    if (bar) bar.style.width = `${Math.min(100, (t.elapsed / t.goal) * 100)}%`;
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
      <div class="t-phase">${t.phase === 'ready' ? 'Get into position' : `Hold · goal ${t.goal}s`}</div>
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

// ================= CLUSTER TIMER =================
// Runs a cluster set part by part: work (hold, or reps tapped "done"), short rest, next part.
function startCluster(exId) {
  const ex = S.exById(exId), p = planOf(exId);
  if (!p?.cluster) return;
  beep(660, 0.05);
  ui.cluster = {
    exId, parts: p.parts, rest: p.clusterRest, idx: 0, results: [],
    hold: ex.kind === 'static', count: p.parts[0],
    phase: ex.kind === 'static' ? 'ready' : 'work', t0: performance.now() + COUNTDOWN * 1000, start: 0, hit: false,
  };
  holdWake(true);
  renderCluster();
  clusterTick();
}

function clusterNext() {
  const c = ui.cluster;
  if (c.idx >= c.parts.length - 1) { c.phase = 'done'; holdWake(false); beep(1320, 0.12, 2); renderCluster(); return; }
  c.phase = 'rest'; c.t0 = performance.now() + c.rest * 1000; c.beeped = new Set();
  renderCluster();
}

/** Countdown or rest is over: start the next work part. */
function clusterBeginPart() {
  const c = ui.cluster;
  if (c.phase === 'rest') { c.idx++; c.count = c.parts[c.idx]; }
  c.phase = 'work'; c.start = performance.now(); c.hit = false; beep(990, 0.18);
  renderCluster();
}

function clusterTick() {
  if (clusterCheck()) ui.cluster.raf = requestAnimationFrame(clusterTick);
}

/** Advance the cluster timer; returns false once there's nothing left to animate. */
function clusterCheck() {
  const c = ui.cluster;
  if (!c || c.phase === 'done') return false;
  const now = performance.now();
  if ((c.phase === 'ready' || c.phase === 'rest') && now >= c.t0) clusterBeginPart();
  const el = $('#timer .t-digits');
  if (el) {
    if (c.phase === 'ready') el.textContent = Math.ceil((c.t0 - now) / 1000);
    else if (c.phase === 'rest') {
      const left = Math.ceil((c.t0 - now) / 1000);
      el.textContent = left;
      if (left <= 3 && left > 0 && !c.beeped.has(left)) { c.beeped.add(left); beep(660, 0.06); }
    } else if (c.phase === 'work' && c.hold) {
      const t = (now - c.start) / 1000;
      el.textContent = t.toFixed(1);
      if (!c.hit && t >= c.parts[c.idx]) { c.hit = true; beep(1320, 0.12, 2); el.classList.add('hit'); }
    }
  }
  return true;
}

function renderCluster() {
  const el = $('#timer');
  const c = ui.cluster;
  if (!c) { el.hidden = true; el.innerHTML = ''; el.className = 'timer'; return; }
  const ex = S.exById(c.exId), d = draftFor(c.exId);
  const u = c.hold ? 's' : '';
  const steps = c.parts.map((n, i) => `<span class="cl-step ${i < c.results.length ? 'done' : i === c.idx && c.phase !== 'done' ? 'cur' : ''}">${i < c.results.length ? c.results[i] : n}${u}</span>`).join('<span class="muted">+</span>');
  const head = `<div class="t-ex">${esc(ex.name)}</div>
    <div class="row">${esc(ex.levels[d.level])} · cluster</div>
    <div class="cl-steps">${steps}</div>`;
  let body = '';
  if (c.phase === 'ready') {
    body = `<div class="t-phase">Get into position</div><div class="t-digits">${COUNTDOWN}</div>
      <div class="t-actions"><button class="btn ghost big" data-act="cl-cancel">Cancel</button></div>`;
  } else if (c.phase === 'work' && c.hold) {
    body = `<div class="t-phase">Part ${c.idx + 1} of ${c.parts.length} · hold ${c.parts[c.idx]}s</div><div class="t-digits">0.0</div>
      <div class="tap-zone"><button class="btn primary big block" style="min-height:96px;font-size:24px" data-act="cl-stop">STOP</button></div>
      <button class="btn ghost sm" data-act="cl-cancel">Cancel cluster</button>`;
  } else if (c.phase === 'work') {
    body = `<div class="t-phase">Part ${c.idx + 1} of ${c.parts.length}</div>
      <div class="t-digits">${c.count}<span style="font-size:.3em"> reps</span></div>
      <div class="counter" style="width:min(86vw,380px)">
        <button data-act="cl-adj" data-d="-1" aria-label="One rep less">−</button><div class="small muted">reps done</div>
        <button data-act="cl-adj" data-d="1" aria-label="One rep more">+</button>
      </div>
      <div class="tap-zone"><button class="btn primary big block" style="min-height:80px;font-size:22px" data-act="cl-done">Done</button></div>
      <button class="btn ghost sm" data-act="cl-cancel">Cancel cluster</button>`;
  } else if (c.phase === 'rest') {
    body = `<div class="t-phase">Rest · next ${c.parts[c.idx + 1]}${u}</div><div class="t-digits">${c.rest}</div>
      <div class="t-actions"><button class="btn ghost big" data-act="cl-skip">Skip rest</button></div>`;
  } else {
    const total = c.results.reduce((a, b) => a + b, 0);
    body = `<div class="t-phase">Cluster done</div>
      <div class="t-digits">${total}<span style="font-size:.3em">${c.hold ? 's' : ' reps'}</span></div>
      <div class="small muted">${c.results.join(' + ')}${u}</div>
      <div class="t-actions">
        <button class="btn ghost big" data-act="cl-discard">Discard</button>
        <button class="btn primary big" data-act="cl-log">Log set</button>
      </div>`;
  }
  el.className = `timer ${c.phase === 'ready' ? 'ready' : ''} ${c.phase === 'rest' ? 'resting' : ''}`;
  el.innerHTML = head + body;
  el.hidden = false;
}

function closeCluster() {
  if (ui.cluster) cancelAnimationFrame(ui.cluster.raf);
  ui.cluster = null;
  holdWake(false);
  renderCluster();
}

// ================= REST TIMER =================
function startRest() {
  const secs = Number(state.restSeconds ?? 90);
  if (state.restOn === false || !secs) return;
  ui.rest = { end: Date.now() + secs * 1000, done: false, paused: false, left: secs };
  renderRest();
  if (ui.tab === 'workout') render();
}
const restLeft = (r) => (r.paused ? r.left : (r.end - Date.now()) / 1000);
function renderRest() {
  const el = $('#rest');
  const r = ui.rest;
  if (!r) { el.hidden = true; return; }
  const left = restLeft(r);
  if (left <= 0 && !r.done && !r.paused) {
    r.done = true; beep(880, 0.15, 3);
    setTimeout(() => { if (ui.rest === r) { ui.rest = null; renderRest(); if (ui.tab === 'workout') render(); } }, 8000);
  }
  el.className = `rest ${r.done ? 'done' : ''} ${r.paused ? 'paused' : ''}`;
  el.innerHTML = `<span class="r-l">${r.done ? 'Go' : r.paused ? 'Paused' : 'Rest'}</span>
    <span class="r-t">${r.done ? '0:00' : fmtClock(Math.ceil(left))}</span>
    ${r.done ? '' : `<button data-act="rest-pause" aria-label="${r.paused ? 'Resume' : 'Pause'} rest timer">${r.paused ? '▶' : '❚❚'}</button>`}
    <button data-act="rest-close" aria-label="Close rest timer">×</button>`;
  el.hidden = false;
}

// ================= ACTIONS =================
/** Save the setup popup's progression, band, weight, tempo and equipment choices. */
function applySetup(f, ex) {
  const d = draftFor(ex.id);
  if (f.level) {
    const lvl = clamp(Number(f.level.value) || 0, 0, ex.levels.length - 1);
    d.level = lvl; ex.currentLevel = lvl;
  }
  d.bands = [...f.querySelectorAll('input[name="band"]:checked')].map((x) => x.value);
  d.bandMode = 'assist';
  if (f.addedKg) d.addedKg = Math.max(0, Number(f.addedKg.value) || 0);
  const tempo = f.querySelector('input[name="tempo"]:checked');
  if (tempo) d.tempo = tempo.value || null;
  const eq = f.querySelector('input[name="equipment"]:checked');
  if (eq && EQUIPMENT[eq.value]) ex.equipment = eq.value;
  S.save();
}

/** Circle tapped: holds/clusters open their timer, reps log the target right away. */
function completeSet(exId) {
  const ex = S.exById(exId), d = draftFor(exId), p = planOf(exId);
  if (p?.cluster) { startCluster(exId); return; }
  if (ex.kind === 'static') { startTimer(exId); return; }
  const value = p ? p.perSet : Number(d.value) || 1;
  logAndCelebrate(exId, { ...d, value });
  render();
}

function logAndCelebrate(exId, draft) {
  const set = S.logSet(exId, draft);
  startRest();
  const ev = set && S.prsFor(exId).events.find((e) => e.entry.id === set.id);
  if (ev) {
    const ex = S.exById(exId);
    toast(ev.type === 'level'
      ? `★ New progression · ${ex.name}: ${set.levelName}`
      : `★ New PR · ${ex.name}${set.tempo ? ` ${TEMPOS[set.tempo].toLowerCase()}` : ''}: ${fmtVal(ex, set.value)}`);
    beep(1320, 0.1, 2);
  }
}

let toastTimer = null;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button data-act="${action.act}">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3500);
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
    S.addExerciseToSession(el.dataset.id); ui.exCollapsed.delete(el.dataset.id); ui.tab = 'workout';
    render();
    openSheet('plan', el.dataset.id);
  },
  'remove-ex': (el) => {
    const s = S.activeSession();
    const n = s?.sets.filter((x) => x.exId === el.dataset.id).length || 0;
    if (n && !confirm(`Remove this exercise and its ${n} logged set(s)?`)) return;
    S.removeExerciseFromSession(el.dataset.id); delete ui.drafts[el.dataset.id];
    if (ui.sheet?.type === 'exdetail') ui.sheet = null;
    render();
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
    const p = planOf(ex.id);
    const asCluster = p?.cluster && Number(d.value) === p.perSet;
    logAndCelebrate(ex.id, asCluster ? { ...d, cluster: p.parts, clusterRest: p.clusterRest } : d);
    render();
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
  'skills-group': (el) => { const g = el.dataset.g; ui.skillsOpen.has(g) ? ui.skillsOpen.delete(g) : ui.skillsOpen.add(g); render(); },
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
  'open-session': (el) => openSheet('session', el.dataset.id),
  cluster: (el) => startCluster(el.dataset.id),
  'cl-cancel': () => closeCluster(),
  'cl-discard': () => closeCluster(),
  'cl-stop': () => {
    const c = ui.cluster;
    c.results.push(Math.max(0, Math.round((performance.now() - c.start) / 1000)));
    clusterNext();
  },
  'cl-adj': (el) => { const c = ui.cluster; c.count = Math.max(0, c.count + Number(el.dataset.d)); renderCluster(); },
  'cl-done': () => { const c = ui.cluster; c.results.push(c.count); clusterNext(); },
  'cl-skip': () => { if (ui.cluster?.phase === 'rest') clusterBeginPart(); },
  'cl-log': () => {
    const c = ui.cluster, d = draftFor(c.exId);
    const total = c.results.reduce((a, b) => a + b, 0);
    const exId = c.exId, parts = [...c.results], rest = c.rest;
    closeCluster();
    if (total > 0) logAndCelebrate(exId, { ...d, value: total, cluster: parts, clusterRest: rest });
    render();
  },
  'plan-edit': (el) => {
    // Coming from the details sheet, go back there after saving.
    ui.sheetReturn = ui.sheet?.type === 'exdetail' ? { ...ui.sheet } : null;
    openSheet('plan', el.dataset.id);
  },
  'ex-detail': (el) => openSheet('exdetail', el.dataset.id),
  'set-do': (el) => completeSet(el.dataset.id),
  'set-add': (el) => completeSet(el.dataset.id),
  'set-edit': (el) => {
    ui.sheetReturn = ui.sheet ? { ...ui.sheet } : null;
    openSheet('setedit', `${el.dataset.session}|${el.dataset.set}`);
  },
  'plan-clear': (el) => {
    const f = el.closest('form'), ex = S.exById(el.dataset.id);
    if (f && ex) applySetup(f, ex);
    S.setPlan(el.dataset.id, ''); ui.sheet = ui.sheetReturn; ui.sheetReturn = null; render();
  },
  'pf-adj': (el) => {
    const input = el.closest('.counter').querySelector('input');
    const min = Number(input.min || 1);
    input.value = Math.max(min, (Number(input.value) || 0) + Number(el.dataset.d));
  },
  'set-edit-delete': (el) => {
    const removed = S.deleteSet(el.dataset.session, el.dataset.set);
    if (removed) { ui.lastDeleted = removed; toast('Set deleted', { act: 'undo-delete', label: 'Undo' }); }
    ui.sheet = ui.sheetReturn; ui.sheetReturn = null;
    render();
  },
  'wk-edit': (el) => openSheet('workout', el.dataset.id),
  'wk-from-session': () => openSheet('workout', 'session'),
  'wk-delete': (el) => {
    if (!confirm('Delete this saved workout? Your logged sessions are not affected.')) return;
    S.deleteWorkout(el.dataset.id); ui.sheet = null; render();
  },
  'wk-start': (el) => {
    const w = state.workouts.find((x) => x.id === el.dataset.id);
    if (!w) return;
    if (S.activeSession()) addWorkoutToSession(w);
    else { S.startFromWorkout(w.id); ui.drafts = {}; }
    ui.tab = 'workout'; ui.sheet = null; render(); window.scrollTo(0, 0);
  },
  'ex-collapse': (el) => { const id = el.dataset.id; ui.exCollapsed.has(id) ? ui.exCollapsed.delete(id) : ui.exCollapsed.add(id); closeBandMenu(); render(); },
  'ex-move': (el) => { S.moveExercise(el.dataset.id, Number(el.dataset.d)); render(); },
  equip: (el) => { const ex = S.exById(el.dataset.id); ex.equipment = el.dataset.e; S.save(); render(); },
  'undo-delete': () => {
    if (!ui.lastDeleted) return;
    S.restoreSet(ui.lastDeleted); ui.lastDeleted = null;
    $('#toast').hidden = true; render();
  },
  'toggle-session': (el) => {
    const id = el.dataset.id;
    ui.openSessions.has(id) ? ui.openSessions.delete(id) : ui.openSessions.add(id);
    render();
  },
  'del-session': (el) => { if (confirm('Delete this session and all its sets?')) { S.deleteSession(el.dataset.id); ui.sheet = null; render(); } },
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
  'rest-add': () => {
    const r = ui.rest;
    if (!r) return;
    if (r.paused) r.left += 15; else r.end += 15000;
    renderRest();
  },
  'rest-pause': () => {
    const r = ui.rest;
    if (!r || r.done) return;
    if (r.paused) { r.end = Date.now() + r.left * 1000; r.paused = false; }
    else { r.left = Math.max(0, (r.end - Date.now()) / 1000); r.paused = true; }
    renderRest();
  },
  'rest-start': () => startRest(),
  'rest-close': () => { ui.rest = null; renderRest(); if (ui.tab === 'workout') render(); },
};

document.addEventListener('click', (e) => {
  if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; e.preventDefault(); e.stopPropagation(); return; }
  // Record "More options" open/closed right away (the native toggle event is async,
  // so a quick tap on a setting could otherwise re-render it closed).
  const sum = e.target.closest('.ex-opts > summary');
  if (sum) {
    const det = sum.parentElement, id = det.dataset.opts;
    det.open ? ui.optsOpen.delete(id) : ui.optsOpen.add(id);
  }
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
  if (t.hasAttribute('data-wk-text')) { updateWorkoutPreview(); return; }
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
  if (t.hasAttribute?.('data-pf-cluster')) {
    t.form.querySelector('[data-pf-cluster-fields]').hidden = !t.checked;
    if (t.checked && !t.form.parts.value) {
      // Suggest a split of the reps into three parts, e.g. 10 -> 4+3+3.
      const n = Math.max(2, Number(t.form.value.value) || 6), a = Math.ceil(n / 3), b = Math.round((n - a) / 2);
      t.form.parts.value = [a, b, n - a - b].filter((x) => x > 0).join('+');
    }
  }
  if (t.dataset.bind === 'level') {
    const ex = S.exById(t.dataset.id), d = draftFor(ex.id);
    const next = clamp(Number(t.value) || 0, 0, ex.levels.length - 1);
    if (next !== d.level) { d.level = next; d.bands = []; d.addedKg = 0; ex.currentLevel = next; S.save(); }
    render();
  }
  if (t.name === 'kind' && t.form?.id === 'ex-form') {
    t.form.querySelector('[data-goal-label]').textContent = t.value === 'reps' ? 'Reps to level up' : 'Hold time to level up (seconds)';
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
  if (t.dataset.setting === 'restSeconds') { state.restSeconds = Math.max(5, Number(t.value) || 90); S.save(); }
  if (t.dataset.setting === 'restOn') {
    state.restOn = t.checked; S.save();
    if (!t.checked) { ui.rest = null; renderRest(); }
    render();
  }
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

// Remember which cards have "More options" open across re-renders.
document.addEventListener('toggle', (e) => {
  const id = e.target.dataset?.opts;
  if (!id) return;
  e.target.open ? ui.optsOpen.add(id) : ui.optsOpen.delete(id);
}, true);

// The click that ends a swipe shouldn't also open the set editor.
let suppressClickUntil = 0;

// ---------- swipe to delete a set ----------
let swipe = null;
document.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('li.swipe');
  if (!li || e.button > 0) return;
  swipe = { li, fg: li.querySelector('.swipe-fg'), x0: e.clientX, y0: e.clientY, dx: 0, active: false, id: e.pointerId };
});
document.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
  if (!swipe.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; } // vertical scroll wins
    if (Math.abs(dx) < 8) return;
    swipe.active = true;
    swipe.li.classList.add('swiping');
  }
  swipe.dx = Math.min(0, dx);
  swipe.fg.style.transform = `translateX(${swipe.dx}px)`;
  swipe.li.classList.toggle('armed', swipe.dx < -80);
});
const endSwipe = (e) => {
  if (!swipe || (e && e.pointerId !== swipe.id)) return;
  const { li, fg, dx, active } = swipe;
  swipe = null;
  if (!active) return;
  suppressClickUntil = Date.now() + 400;
  li.classList.remove('swiping');
  if (dx < -80) {
    fg.style.transform = 'translateX(-110%)';
    setTimeout(() => {
      const removed = S.deleteSet(li.dataset.session, li.dataset.set);
      if (removed) {
        ui.lastDeleted = removed;
        toast('Set deleted', { act: 'undo-delete', label: 'Undo' });
      }
      render();
    }, 160);
  } else {
    fg.style.transform = '';
    li.classList.remove('armed');
  }
};
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);

document.addEventListener('submit', (e) => {
  if (e.target.id === 'set-form') {
    e.preventDefault();
    const f = e.target;
    const patch = {
      value: f.value.value,
      level: f.level.value,
      bands: [...f.querySelectorAll('input[name="band"]:checked')].map((x) => x.value),
    };
    if (f.addedKg) patch.addedKg = f.addedKg.value;
    if (f.tempo) patch.tempo = f.tempo.value;
    if (!(Number(patch.value) > 0)) { alert('Enter a value above 0, or use Delete set.'); return; }
    S.updateSet(f.dataset.session, f.dataset.set, patch);
    ui.sheet = ui.sheetReturn; ui.sheetReturn = null;
    render();
    return;
  }
  if (e.target.id === 'plan-form') {
    e.preventDefault();
    const f = e.target, ex = S.exById(f.dataset.id);
    const sets = Math.max(1, Number(f.sets.value) || 1);
    let text = `${sets}x${Math.max(1, Number(f.value.value) || 1)}`;
    if (f.cluster.checked) {
      const parts = String(f.parts.value).split('+').map((x) => Number(x.trim())).filter((n) => n > 0);
      if (parts.length < 2) { alert('Split each set into at least two parts, like 4+3+3.'); return; }
      text = `${sets}x(${parts.join('+')})/${Math.max(0, Number(f.rest.value) || 0)}s`;
    }
    const p = parsePlan(text);
    applySetup(f, ex);
    S.setPlan(ex.id, formatPlan(p, ex.kind));
    draftFor(ex.id).value = p.perSet;
    ui.sheet = ui.sheetReturn; ui.sheetReturn = null;
    render();
    return;
  }
  if (e.target.id === 'wk-form') {
    e.preventDefault();
    const f = new FormData(e.target);
    const rows = parseWorkoutText(f.get('text') || '', state.exercises.filter((x) => !x.archived));
    const bad = rows.find((r) => r.error);
    if (bad) { alert(`${bad.error}. Fix that line and try again.`); return; }
    if (!rows.length) { alert('Add at least one exercise, one per line.'); return; }
    const seen = new Set();
    const items = rows.filter((r) => !seen.has(r.ex.id) && seen.add(r.ex.id))
      .map((r) => ({ exId: r.ex.id, plan: r.plan ? formatPlan(r.plan, r.ex.kind) : '' }));
    const name = String(f.get('name') || '').trim() || 'Workout';
    S.saveWorkout({ id: e.target.dataset.id || null, name, items });
    ui.sheet = null;
    if (e.submitter?.value === 'start') {
      const w = e.target.dataset.id ? state.workouts.find((x) => x.id === e.target.dataset.id) : state.workouts.at(-1);
      if (S.activeSession()) addWorkoutToSession(w); else { S.startFromWorkout(w.id); ui.drafts = {}; }
      ui.tab = 'workout';
    } else toast(`Saved "${name}"`);
    render();
    return;
  }
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
      bandMode: 'assist',
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
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('li.swipe[data-act="set-edit"]')) { e.preventDefault(); e.target.click(); return; }
  if (e.key === 'Escape') { if (ui.cluster) closeCluster(); else if (ui.timer) closeTimer(); else if (ui.bandMenu) closeBandMenu(); else if (ui.sheet) closeSheet(); }
  if (e.key === ' ' && ui.timer?.phase === 'hold') { e.preventDefault(); stopTimer(); }
});

setInterval(() => { updateTopbar(); if (ui.rest && !ui.rest.done && !ui.rest.paused) renderRest(); }, 500);
// Animation frames stop while the app is in the background; this keeps timer phase
// changes and beeps happening (browsers still run it, at least once a second).
setInterval(() => { holdCheck(); clusterCheck(); }, 250);

render();
