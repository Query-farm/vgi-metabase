/**
 * Usage: content_usage, query_history, recent_views and the instance / edition row.
 *
 * Metabase OSS exposes only lifetime counters (`view_count`, `last_viewed_at` on
 * dashboards, `view_count` / `last_used_at` on cards) and the calling user's recent
 * views. Pro / Enterprise instances with Usage Analytics (the `audit_app` feature)
 * also have the "View log" and "Query log" models in the Usage Analytics collection;
 * when they are there, content_usage and query_history query them read-only through
 * `POST /api/dataset` (an ad-hoc MBQL SELECT that saves nothing).
 */

import type { TableDescriptor } from "@query-farm/vgi";
import { type MetabaseConfig, MetabaseError, metabaseRequest } from "./client.ts";
import { edition, editionOf } from "./lookups.ts";
import { eqValues, timeBounds } from "./pushdown.ts";
import {
  asStr,
  C,
  defaultRows,
  defineMetabaseCatalogTable,
  type MetabaseTableSpec,
  type PhaseRequest,
  type Row,
  type ScanContext,
} from "./table.ts";

const enc = encodeURIComponent;
const DAY = 86_400_000;
/** Rows per POST /api/dataset page (Metabase caps ad-hoc results at 2,000 rows). */
export const DATASET_PAGE_ROWS = 2000;
export const CONTENT_USAGE_DEFAULT_DAYS = 30;
export const QUERY_HISTORY_DEFAULT_DAYS = 7;

/** The [lower, upper) epoch-ms window for a time column: pushed bounds, else the last `days` days. */
export function scanWindow(ctx: ScanContext, column: string, isDate: boolean, days: number): [number, number] {
  const b = timeBounds(ctx.constraints, column, isDate);
  const dayFloor = (ms: number) => Math.floor(ms / DAY) * DAY;
  const upper = b.upper ?? (isDate ? dayFloor(ctx.anchorMs) + DAY : ctx.anchorMs + 1000);
  const lower = b.lower ?? (b.upper !== undefined ? upper - days * DAY : dayFloor(ctx.anchorMs) - (days - 1) * DAY);
  return [lower, upper];
}

export interface AnalyticsModels {
  viewLog: { cardId: number; databaseId: number } | null;
  queryLog: { cardId: number; databaseId: number } | null;
}

const modelCache = new Map<string, { at: number; value: Promise<AnalyticsModels> }>();

/** Forget cached model lookups (tests). */
export function clearModelCache(): void {
  modelCache.clear();
}

/**
 * Find the Usage Analytics "View log" and "Query log" models: models in a collection of
 * type `instance-analytics` (or one below it).
 */
export async function analyticsModels(cfg: MetabaseConfig): Promise<AnalyticsModels> {
  const key = cfg.baseUrl;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = (async () => {
    const cols = defaultRows(await metabaseRequest(cfg, "/collection"));
    const roots = cols.filter((c) => c.type === "instance-analytics").map((c) => String(c.id));
    const ids = cols
      .filter(
        (c) =>
          typeof c.id === "number" &&
          (roots.includes(String(c.id)) || roots.some((r) => String(c.location ?? "").includes(`/${r}/`))),
      )
      .map((c) => String(c.id));
    const out: AnalyticsModels = { viewLog: null, queryLog: null };
    for (const cid of ids) {
      const items = defaultRows(
        await metabaseRequest(cfg, `/collection/${enc(cid)}/items`, { query: { models: "dataset" } }),
      );
      for (const it of items) {
        const name = String(it.name ?? "").toLowerCase();
        const slot = name === "view log" ? "viewLog" : name === "query log" ? "queryLog" : null;
        if (!slot || out[slot]) continue;
        const card = (await metabaseRequest(cfg, `/card/${enc(String(it.id))}`)) as Row;
        out[slot] = { cardId: Number(card.id), databaseId: Number(card.database_id) };
      }
    }
    return out;
  })();
  modelCache.set(key, { at: Date.now(), value });
  value.catch(() => modelCache.delete(key));
  return value;
}

/** A field reference by name on a model source (legacy MBQL, accepted by every version). */
const ref = (name: string, baseType: string, unit?: string) => [
  "field",
  name,
  unit ? { "base-type": baseType, "temporal-unit": unit } : { "base-type": baseType },
];
const TS = "type/DateTimeWithLocalTZ";
const iso = (ms: number) => new Date(ms).toISOString();

/** `{data: {cols, rows}}` → rows keyed by column name (and by position as `$0`, `$1` …). */
export function datasetRows(body: unknown): Row[] {
  const data = (body as Row | null)?.data;
  if (!data) {
    const err = asStr((body as Row | null)?.error);
    if (err) throw new MetabaseError(`Usage Analytics query failed: ${err}`);
    return [];
  }
  const names: string[] = (data.cols ?? []).map((c: Row) => String(c.name));
  return (data.rows ?? []).map((r: unknown[]) => {
    const o: Row = {};
    r.forEach((v, i) => {
      o[`$${i}`] = v;
      const n = names[i];
      if (n && !(n in o)) o[n] = v;
    });
    return o;
  });
}

const titleCache = new Map<string, { at: number; value: Promise<Map<string, string>> }>();

/** "dashboard:2" / "card:40" → title, for Usage Analytics rows. */
function contentTitles(cfg: MetabaseConfig): Promise<Map<string, string>> {
  const hit = titleCache.get(cfg.baseUrl);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = (async () => {
    const [d, c] = await Promise.all([
      metabaseRequest(cfg, "/dashboard", { query: { f: "all" } }),
      metabaseRequest(cfg, "/card", { query: { f: "all" } }),
    ]);
    const m = new Map<string, string>();
    for (const r of defaultRows(d)) m.set(`dashboard:${r.id}`, String(r.name));
    for (const r of defaultRows(c)) m.set(`card:${r.id}`, String(r.name));
    return m;
  })();
  titleCache.set(cfg.baseUrl, { at: Date.now(), value });
  value.catch(() => titleCache.delete(cfg.baseUrl));
  return value;
}

const contentUrl = (type: unknown, id: unknown) =>
  id == null
    ? null
    : type === "dashboard"
      ? `/dashboard/${enc(String(id))}`
      : type === "card"
        ? `/question/${enc(String(id))}`
        : null;

// --------------------------------------------------------------------- content_usage

export const contentUsage: MetabaseTableSpec = {
  name: "content_usage",
  description:
    "Views per dashboard and card: per day from Usage Analytics (Pro/Enterprise), else Metabase's lifetime counters (OSS).",
  title: "Metabase Content Usage",
  category: "usage",
  keywords: "metabase, usage, views, adoption, popularity, usage analytics, view log, dashboards, questions",
  docLlm:
    "Usage of dashboards and cards. On Pro / Enterprise with Usage Analytics (instance.usage_analytics = true) " +
    "it aggregates the 'View log' model: one row per (content_type, content_id, view_date) with view_count, " +
    "user_count (distinct viewers) and last_viewed_at, usage_source 'usage_analytics'; the window comes from " +
    "WHERE view_date bounds (default: the last 30 days, UTC days). On OSS (or without the feature) it returns " +
    "one row per live dashboard and card with Metabase's lifetime view_count and last_viewed_at (cards: " +
    "last_used_at), view_date and user_count NULL, usage_source 'lifetime_counters' — so a view_date filter " +
    "returns no OSS rows. Columns: tool, content_type ('dashboard' or 'card' — other View log types such as " +
    "'table' and 'collection' pass through), content_id, title, view_date, view_count, user_count, " +
    "last_viewed_at, usage_source, url.",
  docMd:
    "Views per dashboard and question. Per day on Pro/Enterprise (Usage Analytics), lifetime counters on OSS. " +
    "See `metabase.main.instance` for which applies.",
  pushdown:
    "Usage Analytics: `view_date` bounds become an MBQL filter on the View log timestamp (default last 30 " +
    "days); `content_type` and `content_id` (`=` / `IN`) become MBQL filters; Metabase groups by day. OSS: " +
    "`content_type` picks the dashboard and/or card listing.",
  key: [],
  columns: [
    C.tool(),
    C.str(
      "content_type",
      "'dashboard' or 'card' (Usage Analytics may also report table / collection views).",
      "__type",
      false,
    ),
    C.str("content_id", "Dashboard or card id.", "__id", false),
    C.str("title", "Dashboard or card name.", "__title"),
    C.date("view_date", "UTC day of the views (NULL for OSS lifetime counters).", "__day"),
    C.bigint("view_count", "Views that day (Usage Analytics) or lifetime views (OSS).", "__views"),
    C.bigint("user_count", "Distinct viewers that day (Usage Analytics only).", "__users"),
    C.time("last_viewed_at", "Latest view in the row's day, or the last view / run ever (OSS).", "__last"),
    C.ctx("usage_source", "'usage_analytics' (View log) or 'lifetime_counters' (OSS counters).", "source"),
    C.url("Web UI link to the content.", (r) => contentUrl(r.__type, r.__id)),
  ],
  fanout: {
    parents: async (ctx) => {
      const types = eqValues(ctx.constraints, "content_type");
      const ed = await edition(ctx.cfg);
      if (ed.usageAnalytics) {
        const m = await analyticsModels(ctx.cfg);
        if (m.viewLog) return [`ee:${m.viewLog.cardId}:${m.viewLog.databaseId}`];
      }
      return ["dashboard", "card"].filter((t) => !types || types.includes(t)).map((t) => `oss:${t}`);
    },
    child: (p, ctx): PhaseRequest => {
      const [mode, a, b] = p.split(":") as [string, string, string];
      if (mode === "oss") {
        return { path: `/${a}`, query: { f: "all" }, ctx: { source: "lifetime_counters", kind: a } };
      }
      const [lo, hi] = scanWindow(ctx, "view_date", true, CONTENT_USAGE_DEFAULT_DAYS);
      const ts = ref("timestamp", TS);
      const filters: unknown[] = [
        [">=", ts, iso(lo)],
        ["<", ts, iso(hi)],
      ];
      const types = eqValues(ctx.constraints, "content_type");
      if (types?.length) filters.push(["=", ref("entity_type", "type/Text"), ...types]);
      const ids = eqValues(ctx.constraints, "content_id")?.filter((v) => /^\d+$/.test(v));
      if (ids?.length) filters.push(["=", ref("entity_id", "type/Integer"), ...ids.map(Number)]);
      return {
        path: "/dataset",
        ctx: { source: "usage_analytics" },
        pageRows: DATASET_PAGE_ROWS,
        pageJson: (offset) => ({
          database: Number(b),
          type: "query",
          query: {
            "source-table": `card__${a}`,
            filter: ["and", ...filters],
            breakout: [ref("entity_type", "type/Text"), ref("entity_id", "type/Integer"), ref("timestamp", TS, "day")],
            aggregation: [["count"], ["distinct", ref("user_id", "type/Integer")], ["max", ts]],
            "order-by": [
              ["asc", ref("entity_type", "type/Text")],
              ["asc", ref("entity_id", "type/Integer")],
              ["asc", ref("timestamp", TS, "day")],
            ],
            page: { page: Math.floor(offset / DATASET_PAGE_ROWS) + 1, items: DATASET_PAGE_ROWS },
          },
          parameters: [],
        }),
      };
    },
  },
  rows: (body, _ctx, req) => {
    if (req.ctx?.source === "usage_analytics") {
      return datasetRows(body).map((r) => ({
        __type: asStr(r.$0),
        __id: asStr(r.$1),
        __day: asStr(r.$2),
        __views: r.$3,
        __users: r.$4,
        __last: r.$5,
      }));
    }
    const kind = req.ctx?.kind;
    return defaultRows(body).map((r) => ({
      __type: kind,
      __id: String(r.id),
      __title: r.name,
      __day: null,
      __views: r.view_count,
      __users: null,
      __last: kind === "dashboard" ? r.last_viewed_at : r.last_used_at,
    }));
  },
  enrich: async (ctx, rows) => {
    if (rows.every((r) => r.__title !== undefined)) return rows;
    const titles = await contentTitles(ctx.cfg);
    return rows.map((r) => ({ ...r, __title: r.__title ?? titles.get(`${r.__type}:${r.__id}`) ?? null }));
  },
  examples: [
    {
      description: "Most-viewed dashboards (per-day rows on Pro/Enterprise are summed)",
      sql: "SELECT content_id, title, sum(view_count) AS views FROM metabase.main.content_usage WHERE content_type = 'dashboard' GROUP BY ALL ORDER BY views DESC LIMIT 10",
    },
    {
      description: "Daily views for one week (Usage Analytics only)",
      sql: "SELECT view_date, sum(view_count) AS views, max(user_count) AS peak_viewers FROM metabase.main.content_usage WHERE view_date >= DATE '2026-11-01' AND view_date < DATE '2026-11-08' GROUP BY ALL ORDER BY view_date",
    },
  ],
};

// --------------------------------------------------------------------- query_history

const QH_EQ: [string, string, string][] = [
  ["card_id", "card_id", "type/Integer"],
  ["dashboard_id", "dashboard_id", "type/Integer"],
  ["user_id", "user_id", "type/Integer"],
  ["database_id", "database_id", "type/Integer"],
  ["source", "query_source", "type/Text"],
];

export const queryHistory: MetabaseTableSpec = {
  name: "query_history",
  description:
    "Every query Metabase ran — runtime, rows, source, error, cache hit — from the Usage Analytics Query log (Pro/Enterprise).",
  title: "Metabase Query History",
  category: "usage",
  keywords: "metabase, query history, query log, performance, runtime, errors, cache, usage analytics",
  docLlm:
    "One row per query execution from the Usage Analytics 'Query log' model (Pro / Enterprise with the " +
    "audit_app feature; read with a read-only POST /api/dataset). OSS keeps no query log reachable through the " +
    "API, so this table raises an error there (check metabase.main.instance.usage_analytics). Columns: tool, " +
    "execution_id, created_at (start, UTC), runtime_seconds, result_rows, status ('complete' or 'error'), " +
    "message (error text), source (dashboard, question, ad-hoc, pulse, csv-download …), is_native, cache_hit, " +
    "card_id, dashboard_id, database_id, user_id, url. The window comes from WHERE created_at bounds (default: " +
    "the last 7 days), read newest-first in pages of 2,000 rows.",
  docMd:
    "Query executions with runtimes, for performance and adoption analysis (Pro/Enterprise Usage Analytics). " +
    "Filter `created_at` to choose the window (default last 7 days).",
  pushdown:
    "`created_at` bounds become MBQL filters on the Query log `started_at` (default last 7 days); `card_id`, " +
    "`dashboard_id`, `user_id`, `database_id` and `source` (`=` / `IN`) become MBQL filters.",
  key: ["execution_id"],
  columns: [
    C.tool(),
    C.str("execution_id", "Query execution id.", (r) => r.entity_id ?? r.id, false),
    C.time("created_at", "When the query started.", "started_at"),
    C.num("runtime_seconds", "Runtime in seconds.", "running_time_seconds"),
    C.bigint("result_rows", "Count of rows the query returned.", "result_rows"),
    C.str("status", "'complete' or 'error'.", (r) => (r.error ? "error" : "complete")),
    C.str("message", "Error text (NULL on success).", "error"),
    C.str("source", "Where the query came from: dashboard, question, ad-hoc, pulse, csv-download …", "query_source"),
    C.bool("is_native", "Whether the query was native SQL.", "is_native"),
    C.bool("cache_hit", "Whether the result came from the cache.", "cache_hit"),
    C.str("card_id", "Card that ran it, if any.", "card_id"),
    C.str("dashboard_id", "Dashboard that ran it, if any.", "dashboard_id"),
    C.str("database_id", "Database queried.", "database_id"),
    C.str("user_id", "User who ran it.", "user_id"),
    C.url("Web UI link to the card, if any.", (r) => contentUrl("card", r.card_id)),
  ],
  fanout: {
    parents: async (ctx) => {
      const ed = await edition(ctx.cfg);
      const m = ed.usageAnalytics ? await analyticsModels(ctx.cfg) : null;
      if (!m?.queryLog) {
        throw new MetabaseError(
          ed.usageAnalytics
            ? "query_history: the Usage Analytics 'Query log' model was not found (does this identity have access to the Usage analytics collection?)"
            : `query_history needs Metabase Pro/Enterprise Usage Analytics (the audit_app feature); this instance (${ed.edition} ${ed.version ?? ""}) does not expose a query log. Use content_usage for OSS view counters.`,
        );
      }
      return [`${m.queryLog.cardId}:${m.queryLog.databaseId}`];
    },
    child: (p, ctx) => {
      const [card, db] = p.split(":") as [string, string];
      const [lo, hi] = scanWindow(ctx, "created_at", false, QUERY_HISTORY_DEFAULT_DAYS);
      const ts = ref("started_at", TS);
      const filters: unknown[] = [
        [">=", ts, iso(lo)],
        ["<", ts, iso(hi)],
      ];
      for (const [col, field, type] of QH_EQ) {
        let vs = eqValues(ctx.constraints, col);
        if (type === "type/Integer") vs = vs?.filter((v) => /^\d+$/.test(v));
        if (vs?.length) filters.push(["=", ref(field, type), ...(type === "type/Integer" ? vs.map(Number) : vs)]);
      }
      return {
        path: "/dataset",
        pageRows: DATASET_PAGE_ROWS,
        pageJson: (offset) => ({
          database: Number(db),
          type: "query",
          query: {
            "source-table": `card__${card}`,
            filter: ["and", ...filters],
            "order-by": [["desc", ts]],
            page: { page: Math.floor(offset / DATASET_PAGE_ROWS) + 1, items: DATASET_PAGE_ROWS },
          },
          parameters: [],
        }),
      };
    },
  },
  rows: (body) => datasetRows(body),
  examples: [
    {
      description: "Slowest questions over the last 7 days",
      sql: "SELECT card_id, count(*) AS runs, avg(runtime_seconds) AS avg_s, max(runtime_seconds) AS max_s FROM metabase.main.query_history WHERE card_id IS NOT NULL AND NOT cache_hit GROUP BY card_id ORDER BY avg_s DESC LIMIT 10",
    },
    {
      description: "Errors by source in a fixed window",
      sql: "SELECT source, count(*) AS errors FROM metabase.main.query_history WHERE status = 'error' AND created_at >= TIMESTAMPTZ '2026-11-01' AND created_at < TIMESTAMPTZ '2026-11-08' GROUP BY ALL ORDER BY errors DESC",
    },
  ],
};

// --------------------------------------------------------------------- recent_views

export const recentViews: MetabaseTableSpec = {
  name: "recent_views",
  description: "What the authenticating user viewed recently (questions, models, dashboards, collections, tables).",
  title: "Metabase Recent Views",
  category: "usage",
  keywords: "metabase, recent views, recents, activity, history",
  docLlm:
    "The recently viewed items of the identity in the metabase secret (GET /api/activity/recent_views; a " +
    "username/password login sees that user's history, an API key usually none). Columns: tool, model (card, " +
    "dataset = model, metric, dashboard, collection, table), id, title, viewed_at, folder_id, folder_name, " +
    "database_id, display, url. Available on every edition.",
  docMd: "The calling user's recently viewed items (OSS and Pro/Enterprise).",
  key: ["model", "id"],
  columns: [
    C.tool(),
    C.str("model", "Item kind: card, dataset (model), metric, dashboard, collection or table.", "model", false),
    id_("Item id."),
    C.str("title", "Item name.", (r) => r.name ?? r.display_name),
    C.time("viewed_at", "When it was viewed.", "timestamp"),
    C.str("folder_id", "Collection holding the item (NULL / 'root' = root).", (r) => r.parent_collection?.id),
    C.str("folder_name", "Name of that collection.", (r) => r.parent_collection?.name),
    C.str("database_id", "Database (cards and tables).", (r) => r.database_id ?? r.database?.id),
    C.str("display", "Visualization (cards).", "display"),
    C.url("Web UI link to the item.", (r) => {
      const id = enc(String(r.id));
      switch (r.model) {
        case "dashboard":
          return `/dashboard/${id}`;
        case "collection":
          return `/collection/${id}`;
        case "dataset":
          return `/model/${id}`;
        case "metric":
          return `/metric/${id}`;
        case "card":
          return `/question/${id}`;
        default:
          return null;
      }
    }),
  ],
  requests: () => [{ path: "/activity/recent_views" }],
  rows: (body) => {
    const b = body as Row | null;
    return Array.isArray(b?.recent_views) ? b.recent_views : defaultRows(b);
  },
  examples: [
    {
      description: "My recently viewed dashboards",
      sql: "SELECT title, viewed_at FROM metabase.main.recent_views WHERE model = 'dashboard' ORDER BY viewed_at DESC",
    },
  ],
};

function id_(doc: string) {
  return C.str("id", doc, "id", false);
}

// --------------------------------------------------------------------- instance

export const instance: MetabaseTableSpec = {
  name: "instance",
  description:
    "The Metabase instance: version, edition (OSS or Pro/Enterprise), Cloud hosting and Usage Analytics availability.",
  title: "Metabase Instance",
  category: "usage",
  keywords: "metabase, version, edition, enterprise, pro, oss, cloud, features, usage analytics",
  docLlm:
    "One row describing the Metabase site (GET /api/session/properties): tool, url, version (e.g. v0.65.4), " +
    "edition ('oss' or 'enterprise' — Pro and Enterprise share the enterprise build, versioned v1.x), " +
    "is_hosted (Metabase Cloud), usage_analytics (the audit_app feature: content_usage / query_history read " +
    "the Usage Analytics models when true), site_name, site_url, site_locale, report_timezone, " +
    "enabled_features (licensed token features). Check usage_analytics before relying on per-day usage.",
  docMd: "Version, edition and licensed features of the instance; tells you which usage source applies.",
  key: ["url"],
  columns: [
    C.tool(),
    C.str("url", "The site's base URL (from the secret).", "__web", false),
    C.str("version", "Version tag, e.g. v0.65.4 (OSS) or v1.65.4 (Pro/Enterprise).", "__ed.version"),
    C.str("edition", "'oss' or 'enterprise' (Pro and Enterprise).", "__ed.edition", false),
    C.bool("is_hosted", "Whether this is Metabase Cloud.", "__ed.isHosted"),
    C.bool("usage_analytics", "Whether Usage Analytics (audit_app) is licensed and enabled.", "__ed.usageAnalytics"),
    C.str("site_name", "Name the admin gave the Metabase site (shown in the UI and emails).", "site-name"),
    C.str("site_url", "Configured site URL.", "site-url"),
    C.str("site_locale", "Default locale.", "site-locale"),
    C.str("report_timezone", "Report timezone (NULL = database timezone).", "report-timezone-long"),
    C.strList("enabled_features", "Licensed token features that are on.", (r) =>
      Object.entries((r["token-features"] ?? {}) as Row)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .sort(),
    ),
  ],
  requests: () => [{ path: "/session/properties" }],
  rows: (body) => [{ ...(body as Row), __ed: editionOf(body as Row) }],
  examples: [
    {
      description: "Which usage source content_usage will use",
      sql: "SELECT version, edition, usage_analytics FROM metabase.main.instance",
    },
  ],
};

export const USAGE_SPECS = [instance, contentUsage, queryHistory, recentViews];
export const USAGE_TABLES: TableDescriptor[] = USAGE_SPECS.map(defineMetabaseCatalogTable);
