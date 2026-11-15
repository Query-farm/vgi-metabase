/**
 * Read a card's `dataset_query` in either of the formats Metabase stores:
 *
 * - legacy MBQL: `{type: "query" | "native", database, query: {source-table, joins, source-query}}`
 *   or `{type: "native", native: {query, template-tags: {name: tag}}}` (Metabase < 0.57);
 * - pMBQL (MBQL 5): `{lib/type: "mbql/query", database, stages: [...]}` where a stage is
 *   `mbql.stage/mbql` (`source-table`, `source-card`, `joins: [{stages}]`) or
 *   `mbql.stage/native` (`native`, `template-tags: [tag]`) (Metabase 0.57+).
 *
 * Only structure is read: the SQL text of native questions is returned as-is and never
 * parsed for table names.
 */

import type { Row } from "./table.ts";

/** One source of a query: a table id or a card id, from the main query or a join. */
export interface QuerySource {
  role: "source" | "join";
  tableId: number | null;
  cardId: number | null;
  joinAlias: string | null;
  /** 0-based stage (pMBQL) or nesting depth (legacy source-query). */
  stage: number;
}

export interface TemplateTag {
  name: string;
  id: string | null;
  type: string | null;
  displayName: string | null;
  default: unknown;
  required: boolean | null;
  dimension: unknown;
}

const isObj = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);

/** pMBQL? (has `stages`) */
export function isPmbql(dq: unknown): boolean {
  return isObj(dq) && Array.isArray(dq.stages);
}

/** 'native' or 'query' (MBQL). */
export function queryType(dq: unknown): "native" | "query" | null {
  if (!isObj(dq)) return null;
  if (isPmbql(dq)) {
    const stages = dq.stages as Row[];
    return stages[0]?.["lib/type"] === "mbql.stage/native" ? "native" : "query";
  }
  if (dq.type === "native" || dq.type === "query") return dq.type;
  return null;
}

export function databaseId(dq: unknown): number | null {
  return isObj(dq) && typeof dq.database === "number" ? dq.database : null;
}

/** The SQL (or other native query text) of a native question. */
export function nativeQuery(dq: unknown): string | null {
  if (!isObj(dq)) return null;
  if (isPmbql(dq)) {
    const s = (dq.stages as Row[])[0];
    if (s?.["lib/type"] !== "mbql.stage/native") return null;
    return typeof s.native === "string" ? s.native : s.native != null ? JSON.stringify(s.native) : null;
  }
  const q = isObj(dq.native) ? dq.native.query : undefined;
  return typeof q === "string" ? q : q != null ? JSON.stringify(q) : null;
}

/** The template tags (`{{variable}}`s) of a native question. */
export function templateTags(dq: unknown): TemplateTag[] {
  if (!isObj(dq)) return [];
  let raw: Row[] = [];
  if (isPmbql(dq)) {
    const s = (dq.stages as Row[])[0];
    const tt = s?.["template-tags"];
    raw = Array.isArray(tt) ? (tt as Row[]) : isObj(tt) ? (Object.values(tt) as Row[]) : [];
  } else if (isObj(dq.native) && isObj(dq.native["template-tags"])) {
    raw = Object.values(dq.native["template-tags"]) as Row[];
  }
  return raw.filter(isObj).map((t) => ({
    name: String(t.name ?? ""),
    id: typeof t.id === "string" ? t.id : null,
    type: typeof t.type === "string" ? t.type : null,
    displayName: typeof t["display-name"] === "string" ? t["display-name"] : null,
    default: t.default ?? null,
    required: typeof t.required === "boolean" ? t.required : null,
    dimension: t.dimension ?? null,
  }));
}

/** `card__12` → 12 */
function cardRef(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^card__(\d+)$/);
  return m ? Number(m[1]) : null;
}

function sourceOf(role: QuerySource["role"], stage: number, alias: string | null, table: unknown, card: unknown) {
  const tableId = typeof table === "number" ? table : null;
  const cardId = typeof card === "number" ? card : cardRef(table);
  return tableId === null && cardId === null ? null : { role, tableId, cardId, joinAlias: alias, stage };
}

/** Every table and card an MBQL query reads (main source and joins, every stage). Native → []. */
export function querySources(dq: unknown): QuerySource[] {
  const out: QuerySource[] = [];
  if (!isObj(dq)) return out;
  if (isPmbql(dq)) {
    const walkStages = (stages: unknown, role: QuerySource["role"], alias: string | null) => {
      if (!Array.isArray(stages)) return;
      stages.forEach((s: unknown, i: number) => {
        if (!isObj(s) || s["lib/type"] === "mbql.stage/native") return;
        const src = sourceOf(role, i, alias, s["source-table"], s["source-card"]);
        if (src) out.push(src);
        for (const j of Array.isArray(s.joins) ? (s.joins as unknown[]) : []) {
          if (!isObj(j)) continue;
          walkStages(j.stages, "join", typeof j.alias === "string" ? j.alias : null);
        }
      });
    };
    walkStages(dq.stages, "source", null);
    return out;
  }
  if (dq.type !== "query") return out;
  const walk = (q: unknown, depth: number) => {
    if (!isObj(q)) return;
    const src = sourceOf("source", depth, null, q["source-table"], undefined);
    if (src) out.push(src);
    if (isObj(q["source-query"])) walk(q["source-query"], depth + 1);
    for (const j of Array.isArray(q.joins) ? (q.joins as unknown[]) : []) {
      if (!isObj(j)) continue;
      const alias = typeof j.alias === "string" ? j.alias : null;
      const js = sourceOf("join", depth, alias, j["source-table"], undefined);
      if (js) out.push(js);
      if (isObj(j["source-query"])) walk(j["source-query"], depth + 1);
    }
  };
  walk(dq.query, 0);
  return out;
}
