// Workout notation: "3x10", "4x15s", "5x5", clusters "3x(4+3+3)" or "3x4+3+3",
// with an optional rest between cluster parts: "3x(4+3+3)/20s" (default 15s).
// Pure functions, no DOM, so they can be tested with plain node.

export const DEFAULT_CLUSTER_REST = 15;

const PLAN_RE = /^\s*(\d+)\s*[x×*]\s*(?:\(\s*(\d+(?:\s*\+\s*\d+)*)\s*\)|(\d+(?:\s*\+\s*\d+)*))\s*(?:s|sec|secs)?\s*(?:\/\s*(\d+)\s*(?:s|sec|secs)?)?\s*$/i;

/**
 * Parse a plan string. Returns null if it isn't valid notation.
 * { sets, parts: [n, ...], perSet, cluster, clusterRest, text }
 */
export function parsePlan(str) {
  if (!str) return null;
  const m = PLAN_RE.exec(String(str));
  if (!m) return null;
  const sets = Number(m[1]);
  const parts = (m[2] || m[3]).split('+').map((x) => Number(x.trim())).filter((n) => n > 0);
  if (!sets || !parts.length) return null;
  const cluster = parts.length > 1;
  const clusterRest = cluster ? Number(m[4]) || DEFAULT_CLUSTER_REST : 0;
  const plan = { sets, parts, perSet: parts.reduce((a, b) => a + b, 0), cluster, clusterRest };
  plan.text = formatPlan(plan);
  return plan;
}

/** Canonical text for a plan; `kind` 'static' adds the seconds unit. */
export function formatPlan(plan, kind) {
  if (!plan) return '';
  const u = kind === 'static' ? 's' : '';
  const body = plan.cluster ? `(${plan.parts.join('+')})` : `${plan.parts[0]}`;
  const rest = plan.cluster && plan.clusterRest !== DEFAULT_CLUSTER_REST ? `/${plan.clusterRest}s` : '';
  return `${plan.sets}x${body}${u}${rest}`;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Find the exercise a name refers to: exact, then prefix, then substring match. */
export function matchExercise(name, exercises) {
  const full = norm(name);
  if (!full) return null;
  // Try the name as typed, then without a plural "s" ("Dips" -> "Dip").
  for (const n of full.endsWith('s') && full.length > 3 ? [full, full.slice(0, -1)] : [full]) {
    const hit = exercises.find((e) => norm(e.name) === n)
      || exercises.find((e) => norm(e.name).startsWith(n))
      || exercises.find((e) => norm(e.name).includes(n));
    if (hit) return hit;
  }
  return null;
}

/**
 * Parse a workout written as text, one exercise per line:
 *   Pull-up 3x8
 *   Front lever 4x10s
 *   Dip 3x(4+3+3)
 * Returns [{ line, name, ex, plan, error }] (blank lines skipped).
 */
export function parseWorkoutText(text, exercises) {
  return String(text).split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = /^(.*?)[\s:,-]+(\d+\s*[x×*].*)$/.exec(line);
    const name = (m ? m[1] : line).trim();
    const planText = m ? m[2].trim() : '';
    const ex = matchExercise(name, exercises);
    const plan = planText ? parsePlan(planText) : null;
    let error = '';
    if (!ex) error = `No exercise called "${name}"`;
    else if (planText && !plan) error = `Can't read "${planText}"`;
    return { line, name, ex, plan, error };
  });
}
