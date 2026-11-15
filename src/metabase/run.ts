/**
 * `run_card(card_id, parameters := '{…}')`: run a saved question, model or metric
 * read-only (`POST /api/card/:id/query`) and return its rows.
 *
 * Binding reads the card (`GET /api/card/:id`) and types the columns from its
 * `result_metadata` (effective / base types): integers BIGINT, floats and decimals
 * DOUBLE, booleans BOOLEAN, dates DATE, zone-less date-times TIMESTAMP, zoned ones
 * TIMESTAMPTZ, JSON / structured values JSON, everything else VARCHAR. A card that
 * has never run has no metadata; then the bind runs the query once to learn its columns.
 */

import {
  batchFromColumns,
  bool,
  dateDay,
  defineTableFunction,
  field,
  float64,
  int64,
  schema,
  secretOfType,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { column, objectTags } from "../meta.ts";
import { configFromSecrets, type MetabaseConfig, MetabaseError, metabaseRequest, SECRET_TYPE } from "./client.ts";
import { templateTags } from "./mbql.ts";
import { asBigInt, asDate, asNum, asStr, asTime, type Row } from "./table.ts";

const enc = encodeURIComponent;

export type Kind = "str" | "double" | "bigint" | "bool" | "date" | "timestamp" | "timestamptz" | "json";

/** Map a Metabase base / effective type to a result column kind. */
export function kindOfType(t: unknown): Kind {
  const s = String(t ?? "");
  if (/^type\/(Integer|BigInteger|Int)$/.test(s)) return "bigint";
  if (/^type\/(Float|Decimal|Number|Currency|Percentage)$/.test(s)) return "double";
  if (s === "type/Boolean") return "bool";
  if (s === "type/Date") return "date";
  if (/^type\/(DateTimeWithTZ|DateTimeWithLocalTZ|DateTimeWithZoneOffset|DateTimeWithZoneID|Instant)$/.test(s))
    return "timestamptz";
  if (s === "type/DateTime") return "timestamp";
  if (/^type\/(JSON|Dictionary|Array|Structured|SerializedJSON)$/.test(s)) return "json";
  return "str";
}

const TYPES: Record<Kind, () => VgiDataType> = {
  str: () => utf8(),
  double: () => float64(),
  bigint: () => int64(),
  bool: () => bool,
  date: () => dateDay(),
  timestamp: () => timestampMicros(),
  timestamptz: () => timestampMicros("UTC"),
  json: () => utf8(),
};

/** Convert one JSON result value to the column kind (unparseable → NULL). */
export function convert(kind: Kind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "double":
      return asNum(v);
    case "bigint":
      return asBigInt(v);
    case "bool":
      return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null;
    case "date":
      return asDate(v);
    case "timestamp": {
      // Zone-less wall-clock time: keep the digits (an offset, if any, is dropped).
      if (typeof v !== "string") return asTime(v);
      const m = v.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)/);
      return asTime(m ? m[1] : v);
    }
    case "timestamptz":
      return asTime(v);
    case "json":
      return typeof v === "string" ? v : JSON.stringify(v);
    default:
      return asStr(v);
  }
}

export interface ResultColumn {
  name: string;
  kind: Kind;
  doc: string;
}

/** Unique column names: a repeated name gets `_2`, `_3` … */
export function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const c = (seen.get(n) ?? 0) + 1;
    seen.set(n, c);
    return c === 1 ? n : `${n}_${c}`;
  });
}

/** Result columns from `result_metadata` or a query response's `data.cols`. */
export function columnsOf(meta: Row[]): ResultColumn[] {
  const names = dedupe(meta.map((m) => String(m.name ?? m.display_name ?? "column")));
  return meta.map((m, i) => ({
    name: names[i] as string,
    kind: kindOfType(m.effective_type ?? m.base_type),
    doc: `${asStr(m.display_name) ?? m.name} (${asStr(m.effective_type ?? m.base_type) ?? "type/*"})`,
  }));
}

function schemaOf(cols: ResultColumn[]): VgiSchema {
  return schema(
    cols.map((c) =>
      c.kind === "json"
        ? field(
            c.name,
            utf8(),
            true,
            new Map([
              ["comment", c.doc],
              ["ARROW:extension:name", "arrow.json"],
            ]),
          )
        : column(c.name, TYPES[c.kind](), c.doc),
    ),
  );
}

/** Map a parameter type for a native template tag. */
function tagParamType(tag: ReturnType<typeof templateTags>[number], raw: Row | undefined): string {
  if (tag.type === "dimension") return asStr(raw?.["widget-type"]) ?? "string/=";
  if (tag.type === "number") return "number/=";
  if (tag.type === "date") return "date/single";
  return "category";
}

/**
 * Turn `parameters := '{"category": "Gizmo"}'` into Metabase's parameter list. Keys match
 * the card's parameters (slug, id or name) or a native question's template tags (name).
 * A JSON array is passed through as Metabase parameter objects.
 */
export function buildParameters(card: Row, raw: string | null): Row[] {
  if (!raw || raw.trim() === "" || raw.trim() === "{}") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MetabaseError(`run_card: parameters must be a JSON object, e.g. '{"category": "Gizmo"}'`);
  }
  if (Array.isArray(parsed)) return parsed as Row[];
  if (!parsed || typeof parsed !== "object") {
    throw new MetabaseError(`run_card: parameters must be a JSON object, e.g. '{"category": "Gizmo"}'`);
  }
  const cardParams: Row[] = Array.isArray(card.parameters) ? card.parameters : [];
  const dq = card.dataset_query;
  const tags = templateTags(dq);
  const rawTags: Row[] = Array.isArray(dq?.stages?.[0]?.["template-tags"])
    ? dq.stages[0]["template-tags"]
    : Object.values((dq?.native?.["template-tags"] ?? {}) as Row);
  const out: Row[] = [];
  for (const [key, value] of Object.entries(parsed as Row)) {
    const p = cardParams.find((x) => x.slug === key || x.id === key || x.name === key);
    if (p) {
      out.push({ id: p.id, type: p.type, target: p.target, value });
      continue;
    }
    const t = tags.find((x) => x.name === key);
    if (t) {
      const rt = rawTags.find((x) => x?.name === key);
      out.push({
        id: t.id ?? key,
        type: tagParamType(t, rt),
        target: [t.type === "dimension" ? "dimension" : "variable", ["template-tag", t.name]],
        value,
      });
      continue;
    }
    const known = [...cardParams.map((x) => String(x.slug ?? x.name)), ...tags.map((x) => x.name)];
    throw new MetabaseError(
      `run_card: card ${card.id} has no parameter '${key}'${known.length ? ` (available: ${known.join(", ")})` : " (it takes none)"}`,
    );
  }
  return out;
}

async function runCard(cfg: MetabaseConfig, id: string, parameters: Row[]): Promise<Row> {
  const body = (await metabaseRequest(cfg, `/card/${enc(id)}/query`, {
    method: "POST",
    json: { parameters, ignore_cache: false },
  })) as Row | null;
  if (!body?.data) {
    const msg = asStr(body?.error) ?? asStr(body?.message) ?? JSON.stringify(body?.errors ?? body).slice(0, 300);
    throw new MetabaseError(`run_card: card ${id} failed: ${msg}`);
  }
  if (body.status && body.status !== "completed") {
    throw new MetabaseError(`run_card: card ${id} finished with status ${body.status}: ${asStr(body.error) ?? ""}`);
  }
  return body;
}

/** Placeholder schema for the first bind pass (before the secret is resolved). */
const PENDING = schema([column("pending", utf8(), "Placeholder until the metabase secret is resolved.")]);

const DYNAMIC_COLUMNS_MD =
  "Columns are the card's result columns, in order, named as Metabase names them (`CATEGORY`, `sum`, `count` …; " +
  "repeats get `_2`, `_3`).\n\n" +
  "| Metabase type | DuckDB type |\n|---|---|\n" +
  "| type/Integer, type/BigInteger | `BIGINT` |\n" +
  "| type/Float, type/Decimal, type/Number | `DOUBLE` |\n" +
  "| type/Boolean | `BOOLEAN` |\n" +
  "| type/Date | `DATE` |\n" +
  "| type/DateTime | `TIMESTAMP` |\n" +
  "| type/DateTimeWithTZ, type/DateTimeWithLocalTZ, type/Instant | `TIMESTAMPTZ` |\n" +
  "| type/JSON, type/Dictionary, type/Array | `JSON` |\n" +
  "| everything else (text, time, UUID …) | `VARCHAR` |\n\n" +
  "Bound without a `metabase` secret, the result is a single placeholder column:\n\n" +
  "| Name | Type | Description |\n|---|---|---|\n" +
  "| pending | VARCHAR | Placeholder; create a metabase secret to get the real columns |";

interface RunArgs {
  card_id: string;
  parameters: string;
}

export const runCardFn: VgiFunction = defineTableFunction<RunArgs, { done: number }>({
  name: "run_card",
  description:
    "Run a saved question, model or metric (read-only) and return its rows, typed from the card's result metadata.",
  args: { card_id: utf8(), parameters: utf8() },
  argDocs: {
    card_id: "Numeric id of the saved question, model or metric to run; find ids in metabase.main.charts.",
    parameters:
      "JSON object of parameter values keyed by the card's parameter slug or a native question's variable name, e.g. '{\"category\": \"Gizmo\"}' (default: none, so defaults apply).",
  },
  argDefaults: { parameters: "{}" },
  argConstraints: { card_id: { pattern: "^[0-9]+$" } },
  onBind: async (params) => {
    if (!params.resolvedSecretsProvided) return { outputSchema: PENDING, lookupSecretTypes: [SECRET_TYPE] };
    const args = params.args as unknown as Record<string, unknown>;
    const id = asStr(args.card_id);
    if (!id || !/^\d+$/.test(id)) throw new MetabaseError("run_card: card_id must be a numeric card id");
    // Without a metabase secret the columns cannot be known; bind a placeholder and let
    // the scan report the missing secret.
    if (!secretOfType(params.secrets as never, SECRET_TYPE)) return { outputSchema: PENDING };
    const cfg = configFromSecrets(params.secrets);
    const card = (await metabaseRequest(cfg, `/card/${enc(id)}`, { notFoundNull: true })) as Row | null;
    if (!card) throw new MetabaseError(`run_card: card ${id} not found`);
    const parameters = buildParameters(card, asStr(args.parameters));
    let meta: Row[] = Array.isArray(card.result_metadata) ? card.result_metadata : [];
    if (meta.length === 0) meta = ((await runCard(cfg, id, parameters)).data?.cols ?? []) as Row[];
    const cols = columnsOf(meta);
    if (cols.length === 0) throw new MetabaseError(`run_card: card ${id} returns no columns`);
    return { outputSchema: schemaOf(cols) };
  },
  initialState: () => ({ done: 0 }),
  process: async (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    state.done = 1;
    const cfg = configFromSecrets(params.secrets);
    const args = params.args as unknown as Record<string, unknown>;
    const id = asStr(args.card_id) ?? "";
    const card = (await metabaseRequest(cfg, `/card/${enc(id)}`)) as Row;
    const body = await runCard(cfg, id, buildParameters(card, asStr(args.parameters)));
    const data: Row = body.data;
    const names = dedupe(((data.cols ?? []) as Row[]).map((c) => String(c.name ?? c.display_name ?? "column")));
    const index = new Map(names.map((n, i) => [n, i]));
    const kinds = columnsOf((data.cols ?? []) as Row[]);
    const rows: unknown[][] = Array.isArray(data.rows) ? data.rows : [];
    const cols: Record<string, unknown[]> = {};
    for (const f of params.outputSchema.fields) {
      const i = index.get(f.name);
      const isJson = f.metadata?.get("ARROW:extension:name") === "arrow.json";
      const t = String(f.type);
      const kind: Kind = isJson
        ? "json"
        : /^Utf8/i.test(t)
          ? "str"
          : /^Float/i.test(t)
            ? "double"
            : /^Int/i.test(t)
              ? "bigint"
              : /^Bool/i.test(t)
                ? "bool"
                : /^Date/i.test(t)
                  ? "date"
                  : /^Timestamp/i.test(t)
                    ? /UTC/.test(t)
                      ? "timestamptz"
                      : "timestamp"
                    : (kinds[i ?? -1]?.kind ?? "str");
      cols[f.name] = rows.map((r) => (i === undefined ? null : convert(kind, r[i])));
    }
    if (rows.length) out.emit(batchFromColumns(cols, params.outputSchema));
    out.finish();
  },
  tags: {
    domain: "business-intelligence",
    "vgi.result_dynamic_columns_md": DYNAMIC_COLUMNS_MD,
    ...objectTags({
      title: "Run a Saved Question",
      category: "results",
      keywords: "metabase, run card, run question, results, model, metric, data",
      docLlm:
        "`run_card(card_id VARCHAR, parameters := '{…}')` runs a saved question, model or metric read-only " +
        "(POST /api/card/:id/query) and returns its rows. Columns are the card's result columns named as in " +
        "Metabase (e.g. CATEGORY, sum, count), typed from its result metadata: integers `BIGINT`, floats `DOUBLE`, " +
        "booleans `BOOLEAN`, dates `DATE`, date-times `TIMESTAMP` (zoned ones `TIMESTAMPTZ`), JSON `JSON`, " +
        "others `VARCHAR`. " +
        "`parameters` is a JSON object keyed by the card's parameter slug or a native question's {{variable}} " +
        'name, e.g. \'{"category": "Gizmo"}\'; omit it to use the defaults. Metabase returns at most 2,000 ' +
        "rows per API query. Find card ids in charts.",
      docMd:
        "Run a saved question and get typed rows. Pass filter values with `parameters := '{\"slug\": value}'`. " +
        "Results are capped at 2,000 rows by Metabase.",
    }),
  },
  examples: [
    {
      description: "Profile the columns of card 40",
      sql: "SUMMARIZE SELECT * FROM metabase.main.run_card('40')",
    },
    {
      description: "Run a native SQL question with a variable and profile the result",
      sql: "SUMMARIZE SELECT * FROM metabase.main.run_card('41', parameters := '{\"category\": \"Gizmo\"}')",
    },
  ],
});

export const RUN_FUNCTIONS: VgiFunction[] = [runCardFn];
