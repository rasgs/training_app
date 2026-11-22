// State, persistence (localStorage) and the progression logic.
import { DEFAULT_BANDS, TEMPLATES } from './data.js';

const KEY = 'calisthenics-log-v1';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const CURRENT_VERSION = 7;

const fromTemplate = (t) => ({
  id: uid(),
  name: t.name,
  kind: t.kind,
  group: t.group,
  equipment: t.equipment || 'none',
  allowBands: t.bands !== false,
  allowWeight: t.weight !== false,
  goal: t.goal,
  levels: [...t.levels],
  currentLevel: 0,
  archived: false,
});

function seed() {
  return {
    version: CURRENT_VERSION,
    bands: DEFAULT_BANDS.map((b) => ({ id: uid(), ...b })),
    exercises: TEMPLATES.map(fromTemplate),
    sessions: [],
    activeSessionId: null,
    restSeconds: 90,
    historyView: 'list',
    manualPRs: [],
    workouts: [],
  };
}

/** Bring older saved data (or imported backups) up to the current shape. */
export function migrate(s) {
  s.version ??= 1;
  for (const e of s.exercises) {
    if (!e.equipment) e.equipment = TEMPLATES.find((t) => t.name === e.name)?.equipment || 'none';
  }
  if (s.version < 2) {
    // v2 added HSPU to the starter progressions.
    const hspu = TEMPLATES.find((t) => t.name === 'HSPU');
    if (hspu && !s.exercises.some((e) => e.name === 'HSPU')) s.exercises.push(fromTemplate(hspu));
  }
  s.historyView ??= 'list';
  s.manualPRs ??= [];
  s.workouts ??= []; // v7: saved workouts
  if (s.restOn === undefined) {
    // Rest timer on/off switch; "0 seconds" used to mean off.
    s.restOn = Number(s.restSeconds ?? 90) > 0;
    if (!Number(s.restSeconds)) s.restSeconds = 90;
  }
  if (s.version < 3) {
    // v3: progressions rebuilt from the r/bodyweightfitness chart. Exercises with
    // logged sets or PRs keep their levels (history is stored by level index);
    // untouched ones get the new ladder, and new exercises are added.
    const used = new Set([
      ...s.sessions.flatMap((x) => x.sets.map((y) => y.exId)),
      ...s.manualPRs.map((p) => p.exId),
    ]);
    for (const t of TEMPLATES) {
      const e = s.exercises.find((x) => x.name === t.name);
      if (!e) s.exercises.push(fromTemplate(t));
      else if (!used.has(e.id)) Object.assign(e, { levels: [...t.levels], goal: t.goal, kind: t.kind, group: t.group, equipment: t.equipment, currentLevel: 0 });
    }
  }
  if (s.version < 4) remapLegacyLadders(s);
  if (s.version < 6) {
    // v6: Ring support removed from the starter skills (kept if it was ever logged).
    const rs = s.exercises.find((e) => e.name === 'Ring support');
    const used = rs && (s.sessions.some((x) => x.sets.some((y) => y.exId === rs.id)) || s.manualPRs.some((p) => p.exId === rs.id));
    if (rs && !used) {
      s.exercises = s.exercises.filter((e) => e !== rs);
      for (const x of s.sessions) x.exerciseIds = x.exerciseIds.filter((id) => id !== rs.id);
    }
  }
  if (s.version < 5) {
    // v5: per-skill load options. Defaults from the template, but never hide an
    // option the user has already logged with.
    const entries = [...s.sessions.flatMap((x) => x.sets), ...s.manualPRs];
    for (const e of s.exercises) {
      const t = TEMPLATES.find((x) => x.name === e.name);
      const mine = entries.filter((x) => x.exId === e.id);
      e.allowBands = (t ? t.bands !== false : true) || mine.some((x) => x.bands?.length);
      e.allowWeight = (t ? t.weight !== false : true) || mine.some((x) => Number(x.addedKg) > 0);
    }
  }
  s.version = CURRENT_VERSION;
  return s;
}

// v4: exercises logged on the original (pre-chart) ladders are moved onto the
// chart ladders. Each old level maps to [target exercise, new level name].
// Only applied when the exercise still has the exact old ladder (not user-edited).
const LEGACY_LADDERS = {
  Planche: {
    levels: ['Frog stand', 'Tuck', 'Advanced tuck', 'Straddle', 'Half lay', 'Full'],
    map: ['Frog stand', 'Tuck planche', 'Adv tuck planche', 'Straddle planche', 'One leg planche', 'Planche'],
  },
  Handstand: {
    levels: ['Chest to wall', 'Back to wall', 'Freestanding (kick-up)', 'Freestanding (press)'],
    map: ['Wall handstand', 'Wall handstand', 'Handstand', 'Handstand'],
  },
  'Muscle-up': {
    levels: ['Chest-to-bar pull-up', 'Jumping muscle-up', 'Kipping muscle-up', 'Strict muscle-up'],
    map: [['Pull-up', 'Chest-to-bar pull-up'], 'Muscle-up negative', 'Kipping muscle-up', 'Strict bar muscle-up'],
  },
  'Push-up': {
    levels: ['Incline', 'Knee', 'Push-up', 'Diamond', 'Archer', 'Pseudo-planche', 'One-arm'],
    map: ['Incline push-up', 'Incline push-up', 'Push-up', 'Diamond push-up', 'Archer push-up', 'Pseudo planche push-up', 'One-arm push-up'],
  },
  'Pull-up': {
    levels: ['Negatives', 'Pull-up', 'L-sit pull-up', 'Archer pull-up', 'One-arm negatives', 'One-arm pull-up'],
    map: ['Pull-up negative', 'Pull-up', 'L-sit pull-up', 'Archer pull-up', 'One-arm pull-up negative', 'One-arm pull-up'],
  },
  Row: {
    levels: ['Incline row', 'Horizontal row', 'Archer row', 'Tuck front lever row', 'One-arm row'],
    map: ['Incline row', 'Row', 'Archer row', 'Tuck front lever row', 'Front lever row'],
  },
  Dip: {
    levels: ['Bench dip', 'Negative dip', 'Parallel bar dip', 'Straight bar dip', 'Korean dip'],
    map: ['Dip negative', 'Dip negative', 'Dip', 'L-sit dip', 'L-sit dip'],
  },
  'Front lever': {
    levels: ['Tuck', 'Advanced tuck', 'One leg', 'Straddle', 'Half lay', 'Full'],
    map: ['Tuck front lever', 'Adv tuck front lever', 'One leg front lever', 'Straddle front lever', 'Straddle front lever', 'Front lever'],
  },
  'Back lever': {
    levels: ['German hang', 'Tuck', 'Advanced tuck', 'One leg', 'Straddle', 'Full'],
    map: ['German hang', 'Tuck back lever', 'Adv tuck back lever', 'One leg back lever', 'Straddle back lever', 'Back lever'],
  },
  'L-sit': {
    levels: ['Tuck sit', 'One-leg L-sit', 'L-sit', 'Straddle L-sit', 'V-sit'],
    map: ['Tuck L-sit', 'One leg L-sit', 'L-sit', 'Straddle L-sit', '90° V-sit'],
  },
  'Human flag': {
    levels: ['Vertical flag', 'Tuck', 'Straddle', 'Full'],
    map: ['Vertical flag', 'Tuck flag', 'Straddle flag', 'Human flag'],
  },
  Squat: {
    levels: ['Assisted squat', 'Bodyweight squat', 'Bulgarian split squat', 'Shrimp squat', 'Pistol squat'],
    map: ['Assisted squat', 'Full squat', ['Shrimp squat', 'Bulgarian split squat'], ['Shrimp squat', 'Shrimp squat'], 'Pistol squat'],
  },
};

function remapLegacyLadders(s) {
  const byName = (n) => s.exercises.find((e) => e.name === n);
  const moved = new Set(); // entries already on a chart ladder (don't remap twice)
  for (const [name, legacy] of Object.entries(LEGACY_LADDERS)) {
    const ex = byName(name);
    const tpl = TEMPLATES.find((t) => t.name === name);
    if (!ex || !tpl || ex.levels.join('|') !== legacy.levels.join('|')) continue;
    // Resolve each old level index to { ex, level, levelName } on the chart ladders.
    const resolve = (i) => {
      const m = legacy.map[i] ?? legacy.map[legacy.map.length - 1];
      const [targetName, levelName] = Array.isArray(m) ? m : [name, m];
      let target = byName(targetName);
      if (!target) {
        const t = TEMPLATES.find((x) => x.name === targetName);
        if (!t) return null;
        target = fromTemplate(t);
        s.exercises.push(target);
      }
      // Always index into the chart ladder: the target may itself still be converted later.
      const ladder = TEMPLATES.find((x) => x.name === targetName).levels;
      const level = Math.max(0, ladder.indexOf(levelName));
      return { ex: target, level, levelName: ladder[level] };
    };
    const move = (entry) => {
      if (moved.has(entry)) return;
      moved.add(entry);
      const r = resolve(entry.level);
      if (!r) return;
      entry.exId = r.ex.id;
      entry.level = r.level;
      entry.levelName = r.levelName;
    };
    for (const sess of s.sessions) {
      for (const set of sess.sets) if (set.exId === ex.id) move(set);
      // keep the session's exercise list in sync with sets that changed exercise
      for (const set of sess.sets) if (!sess.exerciseIds.includes(set.exId)) sess.exerciseIds.push(set.exId);
      sess.exerciseIds = sess.exerciseIds.filter((id) => id !== ex.id || sess.sets.some((x) => x.exId === ex.id));
    }
    for (const pr of s.manualPRs) if (pr.exId === ex.id) move(pr);
    const cur = resolve(ex.currentLevel);
    Object.assign(ex, { levels: [...tpl.levels], goal: tpl.goal, kind: tpl.kind, group: tpl.group, equipment: tpl.equipment });
    ex.currentLevel = cur && cur.ex === ex ? cur.level : 0;
  }
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (isValidState(s)) return migrate(s);
    }
  } catch { /* storage unavailable or corrupt: fall back to seed */ }
  return seed();
}

export function isValidState(s) {
  return s && Array.isArray(s.bands) && Array.isArray(s.exercises) && Array.isArray(s.sessions);
}

export const state = load();

// A session with no exercises and no sets is a leftover (e.g. the picker was
// closed right after "Start session"); drop it so no clock runs for nothing.
{
  const s = state.sessions.find((x) => x.id === state.activeSessionId);
  if (s && !s.sets.length && !s.exerciseIds.length) {
    state.sessions = state.sessions.filter((x) => x !== s);
    state.activeSessionId = null;
  }
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

save(); // persist the seed on first launch

export function replaceState(next) {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  save();
}

export function resetState() { replaceState(seed()); }

// ---------- lookups ----------
export const exById = (id) => state.exercises.find((e) => e.id === id);
export const bandById = (id) => state.bands.find((b) => b.id === id);
export const activeSession = () => state.sessions.find((s) => s.id === state.activeSessionId) || null;

// ---------- sessions ----------
export function startSession() {
  const s = { id: uid(), startedAt: Date.now(), endedAt: null, exerciseIds: [], sets: [], plans: {} };
  state.sessions.push(s);
  state.activeSessionId = s.id;
  save();
  return s;
}

/** Plan text for an exercise in the active session ("3x10"), or ''. */
export const planFor = (exId) => activeSession()?.plans?.[exId] || '';

export function setPlan(exId, text) {
  const s = activeSession();
  if (!s) return;
  s.plans ||= {};
  if (text) s.plans[exId] = text; else delete s.plans[exId];
  save();
}

// ---------- saved workouts ----------
/** items: [{ exId, plan }] */
export function saveWorkout({ id, name, items }) {
  const existing = id && state.workouts.find((w) => w.id === id);
  if (existing) Object.assign(existing, { name, items });
  else state.workouts.push({ id: uid(), name, items, createdAt: Date.now() });
  save();
}

export function deleteWorkout(id) {
  state.workouts = state.workouts.filter((w) => w.id !== id);
  save();
}

/** Start a session pre-filled with a saved workout's exercises and plans. */
export function startFromWorkout(id) {
  const w = state.workouts.find((x) => x.id === id);
  if (!w) return null;
  const s = startSession();
  for (const it of w.items) {
    if (!exById(it.exId) || s.exerciseIds.includes(it.exId)) continue;
    s.exerciseIds.push(it.exId);
    if (it.plan) s.plans[it.exId] = it.plan;
  }
  save();
  return s;
}

/** The active session as saveable workout items. */
export function sessionAsItems() {
  const s = activeSession();
  return s ? s.exerciseIds.map((exId) => ({ exId, plan: s.plans?.[exId] || '' })) : [];
}

export function finishSession() {
  const s = activeSession();
  if (!s) return;
  s.endedAt = Date.now();
  // Drop empty sessions so history stays meaningful.
  if (s.sets.length === 0) state.sessions = state.sessions.filter((x) => x.id !== s.id);
  state.activeSessionId = null;
  save();
}

export function addExerciseToSession(exId) {
  const s = activeSession();
  if (s && !s.exerciseIds.includes(exId)) { s.exerciseIds.push(exId); save(); }
}

export function removeExerciseFromSession(exId) {
  const s = activeSession();
  if (!s) return;
  s.exerciseIds = s.exerciseIds.filter((id) => id !== exId);
  s.sets = s.sets.filter((x) => x.exId !== exId);
  save();
}

export function logSet(exId, draft) {
  const s = activeSession();
  const ex = exById(exId);
  if (!s || !ex) return null;
  const set = {
    id: uid(),
    exId,
    level: draft.level,
    levelName: ex.levels[draft.level] ?? `Level ${draft.level + 1}`,
    value: Number(draft.value) || 0,
    bands: ex.allowBands === false ? [] : [...draft.bands],
    bandMode: draft.bandMode,
    addedKg: ex.allowWeight === false ? 0 : Number(draft.addedKg) || 0,
    tempo: ex.kind === 'reps' ? draft.tempo || null : null,
    equipment: ex.equipment || 'none',
    // Cluster set: value is the total, parts are the mini-sets (e.g. [4,3,3]).
    ...(Array.isArray(draft.cluster) && draft.cluster.length > 1
      ? { cluster: draft.cluster.map(Number), clusterRest: Number(draft.clusterRest) || 0 } : {}),
    at: Date.now(),
  };
  s.sets.push(set);
  ex.currentLevel = draft.level;
  save();
  return set;
}

/** Removes a set; returns what's needed to undo it. */
export function deleteSet(sessionId, setId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const index = s.sets.findIndex((x) => x.id === setId);
  if (index < 0) return null;
  const [set] = s.sets.splice(index, 1);
  save();
  return { sessionId, set, index };
}

/** Edit a logged set: { value, level, bands, addedKg, tempo }. */
export function updateSet(sessionId, setId, patch) {
  const set = state.sessions.find((x) => x.id === sessionId)?.sets.find((x) => x.id === setId);
  const ex = set && exById(set.exId);
  if (!set || !ex) return;
  if (patch.value !== undefined) set.value = Math.max(0, Number(patch.value) || 0);
  if (patch.level !== undefined) {
    set.level = Math.max(0, Math.min(ex.levels.length - 1, Number(patch.level) || 0));
    set.levelName = ex.levels[set.level];
  }
  if (patch.bands) set.bands = [...patch.bands];
  if (patch.addedKg !== undefined) set.addedKg = Math.max(0, Number(patch.addedKg) || 0);
  if (patch.tempo !== undefined) set.tempo = ex.kind === 'reps' ? patch.tempo || null : null;
  // A cluster whose total no longer matches its parts is just a normal set now.
  if (set.cluster && set.cluster.reduce((a, b) => a + b, 0) !== set.value) delete set.cluster;
  save();
}

export function restoreSet({ sessionId, set, index }) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s || s.sets.some((x) => x.id === set.id)) return;
  s.sets.splice(Math.min(index, s.sets.length), 0, set);
  if (!s.exerciseIds.includes(set.exId)) s.exerciseIds.push(set.exId);
  save();
}

/** Move an exercise up (-1) or down (+1) in the active session. */
export function moveExercise(exId, d) {
  const s = activeSession();
  if (!s) return;
  const i = s.exerciseIds.indexOf(exId), j = i + d;
  if (i < 0 || j < 0 || j >= s.exerciseIds.length) return;
  [s.exerciseIds[i], s.exerciseIds[j]] = [s.exerciseIds[j], s.exerciseIds[i]];
  save();
}

export function deleteSession(id) {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.activeSessionId === id) state.activeSessionId = null;
  save();
}

// ---------- progression logic ----------
const mid = (b) => ((Number(b.minKg) || 0) + (Number(b.maxKg) || 0)) / 2;

/**
 * Net external help in kg for a set (approximate, from band ranges).
 * > 0 means assisted (easier), < 0 means loaded (harder), 0 means clean bodyweight.
 */
export function setLoad(set) {
  const bandKg = set.bands.map(bandById).filter(Boolean).reduce((a, b) => a + mid(b), 0);
  const signed = set.bandMode === 'resist' ? -bandKg : bandKg;
  return signed - (Number(set.addedKg) || 0);
}

export const isAssisted = (set) => set.bandMode === 'assist' && set.bands.some((id) => bandById(id));

/**
 * Compare two sets by "how hard was this": higher level wins, then less
 * assistance, then longer hold / more reps. Returns > 0 if a is better.
 */
export function compareSets(a, b) {
  if (a.level !== b.level) return a.level - b.level;
  const la = setLoad(a), lb = setLoad(b);
  if (Math.abs(la - lb) > 0.01) return lb - la;
  return a.value - b.value;
}

export const bestOf = (sets) => sets.reduce((best, s) => (!best || compareSets(s, best) > 0 ? s : best), null);

/** Chronological list of { session, sets, top } for an exercise. */
export function historyFor(exId) {
  return state.sessions
    .filter((s) => s.sets.some((x) => x.exId === exId))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((session) => {
      const sets = session.sets.filter((x) => x.exId === exId);
      return { session, sets, top: bestOf(sets) };
    });
}

export function lastSetsFor(exId, excludeSessionId) {
  const h = historyFor(exId).filter((x) => x.session.id !== excludeSessionId);
  return h.length ? h[h.length - 1] : null;
}

/**
 * Level-up readiness for the current level: the goal hold time / reps reached
 * in at least 2 of the last 3 sessions trained at this level.
 */
export function readiness(ex) {
  const lvl = ex.currentLevel;
  const atLevel = historyFor(ex.id)
    .map((h) => ({ ...h, sets: h.sets.filter((x) => x.level === lvl && !x.cluster) }))
    .filter((h) => h.sets.length);
  const recent = atLevel.slice(-3);
  const best = (sets) => Math.max(0, ...sets.map((x) => x.value));
  const hits = recent.filter((h) => best(h.sets) >= ex.goal).length;
  const allSets = atLevel.flatMap((h) => h.sets);
  const bestValue = best(allSets);
  const bestAny = bestOf(allSets);
  const isLast = lvl >= ex.levels.length - 1;
  return {
    hits,
    ready: hits >= 2 && !isLast,
    bestValue,
    bestAny,
    pct: Math.min(1, bestValue / (ex.goal || 1)),
    sessionsAtLevel: atLevel.length,
    isLast,
  };
}

// ---------- personal records ----------
/**
 * Manual PR: a record set outside the app (or before you used it).
 * Same shape as a logged set, plus a date and an optional note.
 */
export function addManualPR(pr) {
  const ex = exById(pr.exId);
  if (!ex) return null;
  const entry = {
    id: uid(),
    exId: ex.id,
    level: pr.level,
    levelName: ex.levels[pr.level] ?? `Level ${pr.level + 1}`,
    value: Number(pr.value) || 0,
    bands: pr.bands || [],
    bandMode: pr.bandMode || 'assist',
    addedKg: Number(pr.addedKg) || 0,
    tempo: ex.kind === 'reps' ? pr.tempo || null : null,
    date: pr.date || Date.now(),
    note: pr.note || '',
  };
  state.manualPRs.push(entry);
  save();
  return entry;
}

export function deleteManualPR(id) {
  state.manualPRs = state.manualPRs.filter((p) => p.id !== id);
  save();
}

/** Every performance for an exercise (logged sets + manual PRs), oldest first. */
export function entriesFor(exId) {
  const logged = state.sessions.flatMap((s) => s.sets
    .filter((x) => x.exId === exId)
    .map((x) => ({ ...x, date: x.at || s.startedAt, sessionId: s.id, manual: false })));
  const manual = (state.manualPRs || []).filter((p) => p.exId === exId).map((p) => ({ ...p, manual: true }));
  return [...logged, ...manual].sort((a, b) => a.date - b.date);
}

/**
 * PRs for one exercise. A PR is the best entry at each progression level and
 * tempo (standard / explosive / slow / paused are tracked separately), ranked
 * like everything else: less assistance first, then hold/reps.
 * events = moments a record was set, in time order:
 *   'level'  – first time at a level higher than anything before
 *   'better' – beat the previous best at that level
 * The very first entry for an exercise is not an event (nothing to beat yet).
 */
export function prsFor(exId) {
  const byLevel = {};
  const events = [];
  let maxLevel = -1;
  for (const e of entriesFor(exId)) {
    const key = `${e.level}|${e.tempo || ''}|${e.cluster ? 'cluster' : ''}`;
    const prev = byLevel[key];
    if (!prev || compareSets(e, prev) > 0) {
      byLevel[key] = e;
      if (prev) events.push({ type: 'better', entry: e, prev });
      else if (maxLevel >= 0 && e.level > maxLevel) events.push({ type: 'level', entry: e, prev: null });
    }
    maxLevel = Math.max(maxLevel, e.level);
  }
  // Highest level first; within a level, standard tempo before variants.
  const variant = (e) => (e.tempo ? 1 : 0) + (e.cluster ? 2 : 0);
  const levels = Object.values(byLevel).sort((a, b) => b.level - a.level || variant(a) - variant(b));
  return { levels, events, top: levels[0] || null };
}

/** All PR events across exercises, newest first. */
export function recentPRs(limit = 10) {
  return state.exercises
    .flatMap((ex) => prsFor(ex.id).events.map((ev) => ({ ...ev, ex })))
    .sort((a, b) => b.entry.date - a.entry.date)
    .slice(0, limit);
}
