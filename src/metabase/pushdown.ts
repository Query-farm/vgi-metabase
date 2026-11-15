/**
 * Turn DuckDB's pushed-down WHERE predicates into Metabase API parameters and
 * MBQL filter clauses (for the Usage Analytics models).
 *
 * Every table function here sets `autoApplyFilters: true`, so the SDK re-applies
 * every pushed predicate to each batch exactly. Translation therefore only has to
 * NARROW the upstream request without ever dropping a matching row: predicates we
 * cannot express are simply not sent.
 *
 * Only top-level conjuncts are translated (a predicate under OR/NOT is left to the
 * SDK), so the generated request is always implied by the SQL filter.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

/** One translatable constraint on a column. */
export type Constraint =
  | { kind: "cmp"; column: string; op: "eq" | "gt" | "ge" | "lt" | "le"; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "prefix"; column: string; value: string };

const FLIP: Record<string, "eq" | "gt" | "ge" | "lt" | "le"> = { eq: "eq", gt: "lt", ge: "le", lt: "gt", le: "ge" };

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

function one(e: Expr, out: Constraint[]): void {
  // A bare boolean column (`WHERE account_enabled`) and its negation.
  if (e.node === "column_ref") {
    out.push({ kind: "cmp", column: e.columnName, op: "eq", value: true });
    return;
  }
  if (e.node === "not" && unwrap(e.expression).node === "column_ref") {
    const c = unwrap(e.expression) as Extract<Expr, { node: "column_ref" }>;
    out.push({ kind: "cmp", column: c.columnName, op: "eq", value: false });
    return;
  }
  if (e.node === "and") {
    for (const c of e.children) one(c, out);
    return;
  }
  if (e.node === "comparison" && e.op in FLIP) {
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (l.node === "column_ref" && r.node === "literal" && r.value != null) {
      out.push({ kind: "cmp", column: l.columnName, op: e.op as "eq", value: r.value });
    } else if (r.node === "column_ref" && l.node === "literal" && l.value != null) {
      out.push({ kind: "cmp", column: r.columnName, op: FLIP[e.op] ?? "eq", value: l.value });
    }
    return;
  }
  if (e.node === "in" && !e.negated && e.set.kind === "literal") {
    const col = unwrap(e.expression);
    const values = e.set.values.filter((v) => v != null);
    if (col.node === "column_ref" && values.length > 0 && values.length === e.set.values.length) {
      out.push({ kind: "in", column: col.columnName, values });
    }
    return;
  }
  if (e.node === "call" && e.function === "starts_with" && e.arguments.length === 2) {
    const [c, v] = [unwrap(e.arguments[0] as Expr), unwrap(e.arguments[1] as Expr)];
    if (c.node === "column_ref" && v.node === "literal" && typeof v.value === "string") {
      out.push({ kind: "prefix", column: c.columnName, value: v.value });
    }
  }
}

/** The top-level, translatable constraints of a scan's pushed filters. */
export function constraintsOf(filters: PushdownFilters | undefined): Constraint[] {
  const out: Constraint[] = [];
  for (const f of filters?.filters ?? []) one(f, out);
  return [...out, ...prefixesFromRanges(out)];
}

/** The string after every string starting with `p` (DuckDB's prefix-range upper bound). */
function prefixSuccessor(p: string): string | undefined {
  if (!p) return undefined;
  const last = p.codePointAt(p.length - 1);
  return last === undefined ? undefined : p.slice(0, -1) + String.fromCodePoint(last + 1);
}

/**
 * DuckDB rewrites `starts_with(col, 'ad')` and `col LIKE 'ad%'` into the range
 * `col >= 'ad' AND col < 'ae'`. Recognise that pair and add a prefix constraint so
 * endpoints with `sw` can push it (the range itself is still re-applied exactly).
 */
function prefixesFromRanges(cs: Constraint[]): Constraint[] {
  const out: Constraint[] = [];
  for (const lo of cs) {
    if (lo.kind !== "cmp" || lo.op !== "ge" || typeof lo.value !== "string") continue;
    const hi = prefixSuccessor(lo.value);
    if (cs.some((c) => c.kind === "cmp" && c.column === lo.column && c.op === "lt" && c.value === hi)) {
      out.push({ kind: "prefix", column: lo.column, value: lo.value });
    }
  }
  return out;
}

/** A pushed literal for a TIMESTAMPTZ / DATE column as epoch milliseconds. */
export function toEpochMs(v: unknown, isDate = false): number | undefined {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "bigint") return isDate ? Number(v) * 86_400_000 : Number(v / 1000n);
  if (typeof v === "number") return isDate ? v * 86_400_000 : v;
  if (typeof v === "string") {
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** The tightest [lower, upper) epoch-ms bounds the constraints put on a time column (upper exclusive). */
export function timeBounds(
  constraints: Constraint[],
  column: string,
  isDate = false,
): { lower?: number; upper?: number } {
  let lower: number | undefined;
  let upper: number | undefined;
  // An inclusive upper bound widens by one unit: a day for DATE columns, a second for timestamps
  // (the API filters have second precision), so no matching row is dropped.
  const unit = isDate ? 86_400_000 : 1000;
  for (const c of constraints) {
    if (c.column !== column || c.kind !== "cmp") continue;
    const ms = toEpochMs(c.value, isDate);
    if (ms === undefined) continue;
    if (c.op === "gt" || c.op === "ge" || c.op === "eq") {
      const l = isDate ? ms : Math.floor(ms / 1000) * 1000;
      lower = lower === undefined ? l : Math.max(lower, l);
    }
    if (c.op === "lt" || c.op === "le" || c.op === "eq") {
      const u = c.op === "lt" ? Math.ceil(ms / 1000) * 1000 : Math.floor(ms / unit) * unit + unit;
      upper = upper === undefined ? u : Math.min(upper, u);
    }
  }
  return { lower, upper };
}

/** Equality / IN values pushed for a column (as strings), or undefined if unconstrained. */
export function eqValues(constraints: Constraint[], column: string): string[] | undefined {
  let set: string[] | undefined;
  for (const c of constraints) {
    if (c.column !== column) continue;
    let vs: string[] | undefined;
    const ok = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "bigint";
    if (c.kind === "cmp" && c.op === "eq" && ok(c.value)) vs = [String(c.value)];
    else if (c.kind === "in" && c.values.every(ok)) vs = c.values.map(String);
    if (!vs) continue;
    const next = vs;
    set = set ? set.filter((v) => next.includes(v)) : [...new Set(next)];
  }
  return set;
}

/** A pushed `col = true/false` (or bare boolean column), else undefined. */
export function boolValue(constraints: Constraint[], column: string): boolean | undefined {
  for (const c of constraints) {
    if (c.column === column && c.kind === "cmp" && c.op === "eq" && typeof c.value === "boolean") return c.value;
  }
  return undefined;
}

/** The one exact value a column is pushed to equal, or undefined. */
export function singleEq(constraints: Constraint[], column: string): string | undefined {
  const vs = eqValues(constraints, column);
  return vs && vs.length === 1 ? vs[0] : undefined;
}
