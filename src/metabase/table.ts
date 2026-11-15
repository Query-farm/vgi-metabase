/**
 * One factory for every Metabase list endpoint.
 *
 * A spec names the columns (with a JSON extractor each), how pushed filters become
 * the first request of each phase, and optional enrichment. The factory turns that
 * into a VGI table function (or catalog table) that:
 *
 * - streams one response (or one `limit` + `offset` page) per Arrow batch;
 * - keeps its cursor (phase + offset, or a queue of parent ids for per-parent
 *   endpoints) in serializable state, so a scan resumes on any process over HTTP;
 * - reads the `metabase` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  dateDay,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  struct,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, type MetabaseConfig, metabaseRequest, SECRET_TYPE } from "./client.ts";
import { type Constraint, constraintsOf } from "./pushdown.ts";

export const TOOL = "metabase";

// ------------------------------------------------------------------ column helpers

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Row) => unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: Metabase JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string>; __web?: string };

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asInt = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v);
  return null;
};
export const asBigInt = (v: unknown): bigint | null => {
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  if (typeof v === "bigint") return v;
  return null;
};
export const asNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
/** ISO 8601 (a zone-less `YYYY-MM-DD[T ]HH:MM:SS` is taken as UTC) → TIMESTAMPTZ microseconds. */
export function asTime(v: unknown): bigint | null {
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v)) * 1_000_000n; // epoch seconds
  if (typeof v !== "string" || v === "") return null;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s.replace(" ", "T")}Z`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}
/** `YYYY-MM-DD…` → days since the epoch (DATE). */
export function asDate(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

function mkCol(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  get: (r: Row) => unknown,
  nullable = true,
): Col {
  return { name, type, sqlType, doc, get, nullable };
}

type Path = string | ((r: Row) => unknown);
const pick = (r: Row, p: Path) => (typeof p === "string" ? at(r, p) : p(r));

export interface StructField {
  name: string;
  path: string;
  kind?: "str" | "bool" | "int";
}

export const C = {
  str: (name: string, doc: string, path: Path, nullable = true) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => asStr(pick(r, path)), nullable),
  time: (name: string, doc: string, path: Path) =>
    mkCol(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(pick(r, path))),
  date: (name: string, doc: string, path: Path) => mkCol(name, dateDay(), "DATE", doc, (r) => asDate(pick(r, path))),
  bool: (name: string, doc: string, path: Path) => mkCol(name, bool, "BOOLEAN", doc, (r) => asBool(pick(r, path))),
  int: (name: string, doc: string, path: Path) => mkCol(name, int32, "INTEGER", doc, (r) => asInt(pick(r, path))),
  bigint: (name: string, doc: string, path: Path) =>
    mkCol(name, int64(), "BIGINT", doc, (r) => asBigInt(pick(r, path))),
  num: (name: string, doc: string, path: Path) => mkCol(name, float64(), "DOUBLE", doc, (r) => asNum(pick(r, path))),
  strList: (name: string, doc: string, path: Path) =>
    mkCol(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(pick(r, path))),
  json: (name: string, doc: string, path: Path) => mkCol(name, utf8(), "JSON", doc, (r) => asJson(pick(r, path))),
  /** The constant `tool` column shared by the BI workers (always 'metabase'). */
  tool: () => mkCol("tool", utf8(), "VARCHAR", "The BI tool this row came from: always 'metabase'.", () => TOOL, false),
  /** A web UI link built from the secret's base_url and a path. */
  url: (doc: string, path: (r: Row) => string | null) =>
    mkCol("url", utf8(), "VARCHAR", doc, (r) => {
      const p = path(r);
      return p && r.__web ? `${r.__web}${p}` : null;
    }),
  ctx: (name: string, doc: string, key: string) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null, false),
  structList: (name: string, doc: string, fields: StructField[], path: Path) => {
    const typeOf = (k?: string) => (k === "bool" ? bool : k === "int" ? int64() : utf8());
    const sqlOf = (k?: string) => (k === "bool" ? "BOOLEAN" : k === "int" ? "BIGINT" : "VARCHAR");
    const sqlType = `STRUCT(${fields.map((f) => `${f.name} ${sqlOf(f.kind)}`).join(", ")})[]`;
    return mkCol(name, list(struct(fields.map((f) => field(f.name, typeOf(f.kind))) as never)), sqlType, doc, (r) => {
      const v = pick(r, path);
      if (!Array.isArray(v)) return null;
      return v.map((item) =>
        Object.fromEntries(
          fields.map((f) => {
            const x = at(item, f.path);
            return [f.name, f.kind === "bool" ? asBool(x) : f.kind === "int" ? asBigInt(x) : asStr(x)];
          }),
        ),
      );
    });
  },
};

// --------------------------------------------------------------------- the factory

/** The first request of one phase of a scan. */
export interface PhaseRequest {
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Page with `limit` + `offset` (search endpoints); otherwise one request returns everything. */
  paged?: boolean;
  /** Per-phase values exposed to columns through `C.ctx`. */
  ctx?: Record<string, string>;
  /** A 404 means "no such object" → zero rows. */
  notFoundEmpty?: boolean;
  /** On a 404, try this request instead (an older or newer API spelling). */
  fallback?: PhaseRequest;
  /** POST this JSON body instead of a GET. */
  json?: unknown;
  /** POST a body built from the row offset, paging until a page has fewer than `pageRows` rows. */
  pageJson?: (offset: number) => unknown;
  pageRows?: number;
}

export interface ScanContext {
  constraints: Constraint[];
  cfg: MetabaseConfig;
  /** Wall-clock anchor fixed when the scan started (epoch ms), stable across resumes. */
  anchorMs: number;
}

export interface FnExample {
  sql: string;
  description: string;
}

export interface MetabaseTableSpec {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  columns: Col[];
  /** The primary-key column(s) attested as NOT NULL + PRIMARY KEY on the catalog table. */
  key?: string[];
  /** One request per phase. */
  requests?: (ctx: ScanContext) => PhaseRequest[];
  /**
   * Per-parent endpoints: `parents` lists the parent ids once (honouring pushdown),
   * and `child` builds each parent's request. The pending ids live in the scan state.
   */
  fanout?: {
    parents: (ctx: ScanContext) => Promise<string[]>;
    child: (id: string, ctx: ScanContext) => PhaseRequest;
  };
  /** Pull the rows out of a response body (default: the body is the array). */
  rows?: (body: unknown, ctx: ScanContext, req: PhaseRequest) => Row[];
  /** Enrich a page of rows (extra lookups, e.g. folder paths). */
  enrich?: (ctx: ScanContext, rows: Row[]) => Promise<Row[]>;
  /** Text appended to doc_md describing what pushes down. */
  pushdown?: string;
  examples: FnExample[];
}

interface ScanState {
  phase: number;
  offset: number;
  anchorMs: number;
  /** Fan-out: 0 = parents not listed yet, 1 = listed. */
  listed: number;
  /** Fan-out: pending parent ids, newline-joined (the head is being read). */
  queue: string;
}

/** Extract rows from a body that is an array, a `{data: [...]}` envelope, or a single object. */
export function defaultRows(body: unknown): Row[] {
  if (Array.isArray(body)) return body as Row[];
  if (body && typeof body === "object" && Array.isArray((body as Row).data)) return (body as Row).data as Row[];
  if (body && typeof body === "object") return [body as Row];
  return [];
}

/** The Arrow output schema of a column list (column comments ride along as field metadata). */
export function outputSchemaOf(columns: Col[]) {
  return schema(
    columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

/** Discovery tags shared by a spec's function or table. */
export function tagsOf(spec: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  pushdown?: string;
  columns: Col[];
}): Record<string, string> {
  return {
    domain: "business-intelligence",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

/** Emit rows as one batch shaped like the bound output schema (projection applied). */
export function emitRows(
  out: { emit: (b: never) => void },
  outputSchema: ReturnType<typeof schema>,
  columns: Col[],
  rows: Row[],
): void {
  const cols: Record<string, unknown[]> = {};
  for (const f of outputSchema.fields) {
    const c = columns.find((x) => x.name === f.name);
    cols[f.name] = c ? rows.map((r) => c.get(r)) : rows.map(() => null);
  }
  out.emit(batchFromColumns(cols, outputSchema) as never);
}

/** A spec exposed as a catalog table (`SELECT … FROM metabase.main.dashboards`). */
export function defineMetabaseCatalogTable(spec: MetabaseTableSpec): TableDescriptor {
  const fn = defineMetabaseTable({ ...spec, name: `${spec.name}_scan` });
  const key = spec.key ?? ["id"];
  const record = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY", cols: string[][]) =>
    constraintRecord({
      schemaPath: ["main"],
      table: spec.name,
      id,
      kind,
      columns: cols,
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  const constraints = key.length
    ? [
        ...key.map((k) => record(`${k}_not_null`, "NOT_NULL", [[k]])),
        record(
          "pk",
          "PRIMARY_KEY",
          key.map((k) => [k]),
        ),
      ]
    : [];
  return {
    name: spec.name,
    comment: spec.description,
    columns: outputSchemaOf(spec.columns),
    function: fn,
    constraints,
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

export function defineMetabaseTable(spec: MetabaseTableSpec): VgiFunction {
  const outSchema = outputSchemaOf(spec.columns);
  const extract = spec.rows ?? ((body: unknown) => defaultRows(body));

  return defineTableFunction<Record<string, never>, ScanState>({
    name: spec.name,
    description: spec.description,
    args: {},
    filterPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Metabase returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({ phase: 0, offset: 0, anchorMs: Date.now(), listed: 0, queue: "" }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const scan: ScanContext = { constraints: constraintsOf(params.pushdownFilters), cfg, anchorMs: state.anchorMs };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);

      /** Fetch one page; returns rows and whether the request has more pages. */
      const fetchPage = async (req: PhaseRequest): Promise<{ rows: Row[]; more: boolean }> => {
        const query = req.paged ? { ...req.query, limit: cfg.pageSize, offset: state.offset } : req.query;
        const json = req.pageJson ? req.pageJson(state.offset) : req.json;
        let body = await metabaseRequest(cfg, req.path, {
          method: json !== undefined ? "POST" : "GET",
          query,
          json,
          notFoundNull: req.notFoundEmpty || !!req.fallback,
        });
        if (body === null && req.fallback) {
          req = req.fallback;
          body = await metabaseRequest(cfg, req.path, { query: req.query, notFoundNull: req.notFoundEmpty });
        }
        if (body === null && req.notFoundEmpty) return { rows: [], more: false };
        const rows = extract(body, scan, req).map((r) => ({ ...r, __ctx: req.ctx ?? {}, __web: cfg.baseUrl }));
        const pageSize = req.pageJson ? (req.pageRows ?? 2000) : cfg.pageSize;
        return { rows, more: (!!req.paged || !!req.pageJson) && rows.length >= pageSize };
      };
      /** Emit a page's rows; false when there were none (keep reading). */
      const emit = async (rows: Row[]): Promise<boolean> => {
        let rs = rows;
        if (spec.enrich && rs.length) rs = await spec.enrich(scan, rs);
        if (rs.length === 0) return false;
        emitRows(out, params.outputSchema, spec.columns, rs);
        return true;
      };

      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        let req: PhaseRequest | undefined;
        if (spec.fanout) {
          if (!state.listed) {
            state.queue = [...new Set(await spec.fanout.parents(scan))].join("\n");
            state.listed = 1;
          }
          if (!state.queue) {
            out.finish();
            return;
          }
          req = spec.fanout.child(state.queue.split("\n")[0] as string, scan);
        } else {
          req = spec.requests?.(scan)[state.phase];
          if (!req) {
            out.finish();
            return;
          }
        }
        const page = await fetchPage(req);
        if (page.more) state.offset += page.rows.length;
        else {
          state.offset = 0;
          if (spec.fanout) state.queue = state.queue.split("\n").slice(1).join("\n");
          else state.phase += 1;
        }
        if (await emit(page.rows)) return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}

/** Read every page of a paged search endpoint (for small helper lookups). */
export async function getAllPages(
  cfg: MetabaseConfig,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0, guard = 0; guard < 10_000; guard++) {
    const body = await metabaseRequest(cfg, path, { query: { ...query, limit: cfg.pageSize, offset } });
    const page = defaultRows(body);
    rows.push(...page);
    if (page.length < cfg.pageSize) break;
    offset += page.length;
  }
  return rows;
}
