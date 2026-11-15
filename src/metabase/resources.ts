/**
 * The Metabase REST collections exposed as catalog tables.
 *
 * Content tables share column names with the other BI workers (tool, id, title,
 * folder_path, owner, created_at, updated_at, last_viewed_at, view_count, url) so
 * dashboards, charts, folders, users and connections UNION across tools.
 */

import type { TableDescriptor } from "@query-farm/vgi";
import { metabaseRequest } from "./client.ts";
import { collections, databaseNames, maskRecipients, safeDetails, tableInfo, withFolderAndOwner } from "./lookups.ts";
import { databaseId, nativeQuery, querySources, queryType, templateTags } from "./mbql.ts";
import { boolValue, singleEq } from "./pushdown.ts";
import {
  asStr,
  C,
  type Col,
  defaultRows,
  defineMetabaseCatalogTable,
  type MetabaseTableSpec,
  type PhaseRequest,
  type Row,
  type ScanContext,
} from "./table.ts";

const enc = encodeURIComponent;
const idOf = (v: unknown) => (v == null ? null : String(v));
const isId = (v: string | undefined): v is string => !!v && /^\d+$/.test(v);

const id = (doc: string) => C.str("id", doc, "id", false);
const owner = C.str("owner", "Display name of the user who created the object.", "__owner");
const folderPath = C.str(
  "folder_path",
  "Slash-separated collection path from the root ('Our analytics' is '/'), e.g. /Marketing/EMEA.",
  "__folder_path",
);
const folderId = C.str(
  "folder_id",
  "Id of the collection holding the object (NULL = root collection).",
  "collection_id",
);
const ownerName = (r: Row) => r.creator?.common_name ?? r.creator?.email;

/** Phases for "live then archived" list endpoints, honouring a pushed `archived` filter. */
function archivedPhases(ctx: ScanContext, live: PhaseRequest, archived: PhaseRequest): PhaseRequest[] {
  const a = boolValue(ctx.constraints, "archived");
  return a === true ? [archived] : a === false ? [live] : [live, archived];
}

const PARAM_FIELDS = [
  { name: "id", path: "id" },
  { name: "name", path: "name" },
  { name: "slug", path: "slug" },
  { name: "type", path: "type" },
  { name: "default_value", path: "default" },
  { name: "required", path: "required", kind: "bool" as const },
];

// ---------------------------------------------------------------------- folders

export const folders: MetabaseTableSpec = {
  name: "folders",
  description: "Metabase collections (the folder tree) with full paths, personal owners and archive state.",
  title: "Metabase Collections",
  category: "content",
  keywords: "metabase, collections, folders, tree, personal collection, official, archived",
  docLlm:
    "One row per Metabase collection (GET /api/collection, live and archived). Columns: tool ('metabase'), id, " +
    "title, folder_path (the collection's own path, e.g. /Marketing/EMEA; the root 'Our analytics' is '/' and " +
    "has no row), parent_id (NULL = root), owner / owner_id (the personal-collection owner, NULL for shared " +
    "collections), created_at, url, description, slug, location (ancestor ids '/8/'), is_personal, archived, " +
    "namespace, collection_type ('instance-analytics' = Usage Analytics, 'trash', or NULL), authority_level " +
    "('official' on Pro/Enterprise), entity_id. Join charts / dashboards on folder_id = id.",
  docMd: "The collection tree with the shared BI columns `tool, id, title, folder_path, owner, created_at, url`.",
  pushdown: "`archived` chooses between the live and archived listings.",
  columns: [
    C.tool(),
    id("Collection id."),
    C.str("title", "Collection name.", "name"),
    folderPath,
    C.str("parent_id", "Id of the parent collection (NULL = root).", (r) =>
      (asStr(r.location) ?? "/").split("/").filter(Boolean).pop(),
    ),
    owner,
    C.str(
      "owner_id",
      "Id of the user whose personal collection this is (NULL for shared collections).",
      "personal_owner_id",
    ),
    C.time("created_at", "When the collection was created.", "created_at"),
    C.url("Web UI link to the collection.", (r) => `/collection/${enc(String(r.id))}`),
    C.str("description", "Collection description.", "description"),
    C.str("slug", "URL slug.", "slug"),
    C.str("location", "Ancestor collection ids, e.g. '/8/'.", "location"),
    C.bool("is_personal", "Whether this is (inside) a personal collection.", (r) =>
      typeof r.is_personal === "boolean" ? r.is_personal : r.personal_owner_id != null,
    ),
    C.bool("archived", "Whether the collection is in the trash.", "archived"),
    C.str("namespace", "Collection namespace (NULL for regular collections; e.g. 'snippets').", "namespace"),
    C.str("collection_type", "Special type: 'instance-analytics' (Usage Analytics), 'trash', or NULL.", "type"),
    C.str("authority_level", "'official' for official collections (Pro/Enterprise), else NULL.", "authority_level"),
    C.str("entity_id", "Stable entity id used by serialization.", "entity_id"),
  ],
  requests: (ctx) => archivedPhases(ctx, { path: "/collection" }, { path: "/collection", query: { archived: true } }),
  // The archived listing also holds the Trash collection (archived = false), which the live
  // listing omits; any live collection it repeats is dropped so each row appears once.
  rows: (body, _ctx, req) => {
    const archivedPhase = req.query?.archived === true;
    return defaultRows(body).filter(
      (r) =>
        typeof r.id === "number" && (archivedPhase ? r.archived === true || r.type === "trash" : r.archived !== true),
    );
  },
  enrich: async (ctx, rows) => {
    const [paths, out] = await Promise.all([
      collections(ctx.cfg),
      withFolderAndOwner(ctx.cfg, rows, null, (r) => r.personal_owner_id),
    ]);
    return out.map((r) => ({ ...r, __folder_path: paths.get(String(r.id))?.path ?? null }));
  },
  examples: [
    {
      description: "The collection tree, deepest paths last",
      sql: "SELECT folder_path, title, is_personal FROM metabase.main.folders WHERE NOT archived ORDER BY length(folder_path), folder_path",
    },
    {
      description: "Content per collection",
      sql: "SELECT f.folder_path, count(c.id) AS charts FROM metabase.main.folders f LEFT JOIN metabase.main.charts c ON c.folder_id = f.id GROUP BY f.folder_path ORDER BY charts DESC",
    },
  ],
};

// -------------------------------------------------------------------- dashboards

export const dashboards: MetabaseTableSpec = {
  name: "dashboards",
  description: "Metabase dashboards with collection path, creator, view counts and filter parameters.",
  title: "Metabase Dashboards",
  category: "content",
  keywords: "metabase, dashboards, content, bi, collections, views, filters, parameters",
  docLlm:
    "One row per Metabase dashboard (GET /api/dashboard?f=all, plus f=archived). Columns: tool ('metabase'), " +
    "id, title, description, folder_id (collection id, NULL = root), folder_path (/Marketing/EMEA, root '/'), " +
    "owner (creator display name), owner_id, created_at, updated_at, last_viewed_at, view_count (lifetime views " +
    "Metabase counts), url, archived, collection_position (pinned position), is_public (has a public link), " +
    "enable_embedding, auto_apply_filters, width, cache_ttl, entity_id, parameters (list of filter structs: " +
    "id, name, slug, type, default_value JSON, required). Cards on the dashboard are in dashboard_cards, tabs " +
    "in dashboard_tabs. WHERE id = … reads one dashboard; archived picks the listing.",
  docMd:
    "Dashboards with the shared BI columns (`tool, id, title, folder_path, owner, created_at, updated_at, " +
    "last_viewed_at, view_count, url`) plus Metabase-specific fields and the filter parameters.",
  pushdown:
    "`archived` chooses the live (`f=all`) or archived listing. `id` is filtered locally: Metabase counts " +
    "`GET /api/dashboard/:id` as a view, so this table never calls it.",
  columns: [
    C.tool(),
    id("Dashboard id."),
    C.str("title", "Dashboard name.", "name"),
    C.str("description", "Dashboard description.", "description"),
    folderId,
    folderPath,
    owner,
    C.str("owner_id", "Id of the user who created the dashboard.", "creator_id"),
    C.time("created_at", "When the dashboard was created.", "created_at"),
    C.time("updated_at", "When the dashboard was last updated.", "updated_at"),
    C.time("last_viewed_at", "When the dashboard was last viewed.", "last_viewed_at"),
    C.bigint("view_count", "Count of lifetime views Metabase has recorded for the dashboard.", "view_count"),
    C.url("Web UI link to the dashboard.", (r) => `/dashboard/${enc(String(r.id))}`),
    C.bool("archived", "Whether the dashboard is in the trash.", "archived"),
    C.int("collection_position", "Pinned position in its collection (NULL = not pinned).", "collection_position"),
    C.bool(
      "is_public",
      "Whether the dashboard has a public sharing link (the link itself is not returned).",
      (r) => r.public_uuid != null || r.public_uuid_prefix != null,
    ),
    C.bool("enable_embedding", "Whether static embedding is enabled.", "enable_embedding"),
    C.bool("auto_apply_filters", "Whether filter changes apply immediately.", "auto_apply_filters"),
    C.str("width", "Layout width: fixed or full.", "width"),
    C.int("cache_ttl", "Cache TTL override in hours (NULL = default).", "cache_ttl"),
    C.str("entity_id", "Stable entity id used by serialization.", "entity_id"),
    C.structList(
      "parameters",
      "Dashboard filters: id, name, slug, type, default value (JSON) and required.",
      PARAM_FIELDS,
      "parameters",
    ),
  ],
  requests: (ctx) =>
    archivedPhases(ctx, { path: "/dashboard", query: { f: "all" } }, { path: "/dashboard", query: { f: "archived" } }),
  enrich: async (ctx, rows) => {
    const withOwner = rows.map((r) => ({ ...r, __owner: ownerName(r) }));
    return withFolderAndOwner(
      ctx.cfg,
      withOwner,
      (r) => r.collection_id,
      (r) => r.creator_id,
    );
  },
  examples: [
    {
      description: "Most-viewed dashboards with their collection path",
      sql: "SELECT title, folder_path, owner, view_count FROM metabase.main.dashboards WHERE NOT archived ORDER BY view_count DESC LIMIT 10",
    },
    {
      description: "Dashboards nobody has opened in 90 days",
      sql: "SELECT id, title, owner, last_viewed_at FROM metabase.main.dashboards WHERE last_viewed_at < now() - INTERVAL 90 DAY ORDER BY last_viewed_at",
    },
  ],
};

/** Ids of dashboards to fan out over: a pushed dashboard_id, else every live dashboard. */
async function dashboardIds(ctx: ScanContext): Promise<string[]> {
  const one = singleEq(ctx.constraints, "dashboard_id");
  if (isId(one)) return [one];
  const rows = defaultRows(await metabaseRequest(ctx.cfg, "/dashboard", { query: { f: "all" } }));
  return rows.map((r) => String(r.id));
}

const MAPPING_FIELDS = [
  { name: "parameter_id", path: "parameter_id" },
  { name: "card_id", path: "card_id", kind: "int" as const },
  { name: "target", path: "target" },
];

export const dashboardCards: MetabaseTableSpec = {
  name: "dashboard_cards",
  description:
    "Cards placed on dashboards (questions and text/heading/link cards) with tab, position and filter wiring.",
  title: "Metabase Dashboard Cards",
  category: "content",
  keywords: "metabase, dashcards, dashboard cards, tiles, layout, tabs, filters, parameter mappings",
  docLlm:
    "One row per card placed on a dashboard (GET /api/dashboard/:id, one call per dashboard). Columns: tool, id " +
    "(dashcard id), dashboard_id, dashboard_title, tab_id, tab_name, card_id (NULL for text / heading / link " +
    "cards), card_title, card_type (question, model, metric), display (bar, table, text, heading …), " +
    "is_virtual, text (markdown of text / heading cards), row, col, size_x, size_y, series_card_ids (extra " +
    "series combined into the card), parameter_mappings (which dashboard filter drives which field or template " +
    "tag: parameter_id, card_id, target JSON), action_id, url. Filter on dashboard_id to read one dashboard; " +
    "otherwise every live dashboard is read. Note: Metabase records each GET /api/dashboard/:id as a view of " +
    "that dashboard (view_count, Usage Analytics View log) by the secret's identity.",
  docMd:
    "Dashboard layout: every card on every dashboard with its tab, grid position and the filters wired to it. " +
    "Metabase counts each dashboard read as a view, so use a dedicated API key.",
  pushdown: "`dashboard_id = …` reads only that dashboard (otherwise one request per live dashboard).",
  key: ["id"],
  columns: [
    C.tool(),
    id("Dashboard card (dashcard) id."),
    C.str("dashboard_id", "Id of the dashboard.", "dashboard_id"),
    C.str("dashboard_title", "Name of the dashboard.", "__dashboard_title"),
    C.str(
      "tab_id",
      "Id of the dashboard tab the card is on (NULL when the dashboard has no tabs).",
      "dashboard_tab_id",
    ),
    C.str("tab_name", "Name of the dashboard tab.", "__tab_name"),
    C.str("card_id", "Id of the question / model / metric shown (NULL for virtual cards).", "card_id"),
    C.str("card_title", "Name of the card shown.", (r) => (r.card_id != null ? r.card?.name : null)),
    C.str("card_type", "Card type: question, model or metric.", (r) => (r.card_id != null ? r.card?.type : null)),
    C.str("display", "Visualization: bar, line, table, scalar … or text / heading / link for virtual cards.", (r) =>
      r.card_id != null ? r.card?.display : (r.visualization_settings?.virtual_card?.display ?? null),
    ),
    C.bool(
      "is_virtual",
      "Whether this is a text, heading, link or iframe card with no question.",
      (r) => r.card_id == null,
    ),
    C.str("text", "Markdown of a text or heading card.", (r) => r.visualization_settings?.text ?? null),
    C.int("row", "Grid row (top edge).", "row"),
    C.int("col", "Grid column (left edge).", "col"),
    C.int("size_x", "Width in grid columns.", "size_x"),
    C.int("size_y", "Height in grid rows.", "size_y"),
    {
      ...C.strList("series_card_ids", "Ids of extra cards combined into this card as series.", (r) =>
        Array.isArray(r.series) ? r.series.map((s: Row) => s?.id) : null,
      ),
    },
    C.structList(
      "parameter_mappings",
      "Dashboard filters wired to this card: parameter_id, card_id and the target (field or template tag) as JSON.",
      MAPPING_FIELDS,
      "parameter_mappings",
    ),
    C.str("action_id", "Id of the action of an action button, if any.", "action_id"),
    C.url("Web UI link to the dashboard (and tab).", (r) =>
      r.dashboard_id != null
        ? `/dashboard/${enc(String(r.dashboard_id))}${r.dashboard_tab_id != null ? `?tab=${enc(String(r.dashboard_tab_id))}` : ""}`
        : null,
    ),
  ],
  fanout: {
    parents: dashboardIds,
    child: (dash) => ({ path: `/dashboard/${enc(dash)}`, notFoundEmpty: true }),
  },
  rows: (body) => {
    const d = body as Row | null;
    if (!d) return [];
    const tabs = new Map<string, string>((d.tabs ?? []).map((t: Row) => [String(t.id), String(t.name)]));
    const cards: Row[] = d.dashcards ?? d.ordered_cards ?? [];
    return cards.map((c) => ({
      ...c,
      dashboard_id: c.dashboard_id ?? d.id,
      __dashboard_title: d.name,
      __tab_name: c.dashboard_tab_id != null ? (tabs.get(String(c.dashboard_tab_id)) ?? null) : null,
    }));
  },
  examples: [
    {
      description: "Cards per dashboard tab",
      sql: "SELECT dashboard_title, tab_name, count(*) AS cards, count(card_id) AS questions FROM metabase.main.dashboard_cards GROUP BY ALL ORDER BY dashboard_title, tab_name",
    },
    {
      description: "Which dashboard filters drive which card",
      sql: "SELECT d.card_title, m.parameter_id, m.target FROM metabase.main.dashboard_cards d, unnest(d.parameter_mappings) AS t(m) WHERE d.dashboard_id = '2' ORDER BY d.card_title",
    },
  ],
};

export const dashboardTabs: MetabaseTableSpec = {
  name: "dashboard_tabs",
  description: "Dashboard tabs with their position and card count.",
  title: "Metabase Dashboard Tabs",
  category: "content",
  keywords: "metabase, dashboard tabs, tabs, layout",
  docLlm:
    "One row per dashboard tab (GET /api/dashboard/:id, one call per dashboard). Columns: tool, id (tab id), " +
    "dashboard_id, dashboard_title, title (tab name), position (0-based), card_count, created_at, updated_at, url. " +
    "Dashboards without tabs have no rows. Filter on dashboard_id to read one dashboard. Like dashboard_cards, " +
    "each dashboard read counts as a view in Metabase.",
  docMd: "The tabs of each dashboard and how many cards each holds.",
  pushdown: "`dashboard_id = …` reads only that dashboard.",
  columns: [
    C.tool(),
    id("Dashboard tab id."),
    C.str("dashboard_id", "Id of the dashboard.", "dashboard_id"),
    C.str("dashboard_title", "Name of the dashboard.", "__dashboard_title"),
    C.str("title", "Tab name.", "name"),
    C.int("position", "Index (from 0) of the tab, left to right.", "position"),
    C.bigint("card_count", "Number of cards on the tab.", "__card_count"),
    C.time("created_at", "When the tab was created.", "created_at"),
    C.time("updated_at", "When the tab was last updated.", "updated_at"),
    C.url("Web UI link to the tab.", (r) => `/dashboard/${enc(String(r.dashboard_id))}?tab=${enc(String(r.id))}`),
  ],
  fanout: dashboardCards.fanout,
  rows: (body) => {
    const d = body as Row | null;
    if (!d) return [];
    const cards: Row[] = d.dashcards ?? [];
    return (d.tabs ?? []).map((t: Row) => ({
      ...t,
      dashboard_id: t.dashboard_id ?? d.id,
      __dashboard_title: d.name,
      __card_count: cards.filter((c) => String(c.dashboard_tab_id) === String(t.id)).length,
    }));
  },
  examples: [
    {
      description: "Dashboards with the most tabs",
      sql: "SELECT dashboard_title, count(*) AS tabs, sum(card_count) AS cards FROM metabase.main.dashboard_tabs GROUP BY dashboard_title ORDER BY tabs DESC",
    },
  ],
};

// ------------------------------------------------------------------------ cards

/** Requests for card lists, honouring id / database_id / table_id / archived pushdown. */
function cardRequests(ctx: ScanContext, idColumn = "id"): PhaseRequest[] {
  const one = singleEq(ctx.constraints, idColumn);
  if (isId(one)) return [{ path: `/card/${one}`, notFoundEmpty: true }];
  const db = singleEq(ctx.constraints, "database_id");
  const table = singleEq(ctx.constraints, "table_id");
  // f=database / f=table list live cards only, so archived cards come from f=archived.
  const live: PhaseRequest = isId(table)
    ? { path: "/card", query: { f: "table", model_id: table } }
    : isId(db)
      ? { path: "/card", query: { f: "database", model_id: db } }
      : { path: "/card", query: { f: "all" } };
  return archivedPhases(ctx, live, { path: "/card", query: { f: "archived" } });
}

const cardUrl = (r: Row) => {
  const kind = r.type === "model" ? "model" : r.type === "metric" ? "metric" : "question";
  return `/${kind}/${enc(String(r.id))}`;
};

const cardEnrich = async (ctx: ScanContext, rows: Row[]) =>
  withFolderAndOwner(
    ctx.cfg,
    rows.map((r) => ({ ...r, __owner: ownerName(r) })),
    (r) => r.collection_id,
    (r) => r.creator_id,
  );

export const charts: MetabaseTableSpec = {
  name: "charts",
  description: "Saved questions, models and metrics (cards) with collection path, creator, usage and query kind.",
  title: "Metabase Charts",
  category: "content",
  keywords: "metabase, cards, questions, saved questions, models, metrics, charts, visualizations",
  docLlm:
    "One row per Metabase card — saved question, model or metric (GET /api/card?f=all plus f=archived). " +
    "Columns: tool ('metabase'), id, title, description, card_type (question, model, metric), display (bar, " +
    "line, table, scalar, pie …), query_type ('native' SQL or 'query' = MBQL / query builder), database_id, " +
    "table_id (main source table of MBQL cards), source_card_id (card this one is built on), folder_id, " +
    "folder_path, owner, owner_id, created_at, updated_at, last_viewed_at (Metabase's last_used_at: the last " +
    "time the card ran — it keeps no separate last-view time for cards), last_used_at, view_count, url, " +
    "archived, dashboard_id (set for questions saved inside a dashboard), collection_position, is_public, " +
    "enable_embedding, cache_ttl, entity_id. The query text is in queries; lineage in card_tables.",
  docMd:
    "Cards (questions, models, metrics) with the shared BI columns. Metabase calls these *questions*; " +
    "`charts` is the name shared with the Looker and Tableau workers.",
  pushdown:
    "`id = …` reads `/api/card/:id`; `table_id = …` and `database_id = …` use `f=table` / `f=database`; " +
    "`archived` chooses the live or archived listing.",
  columns: [
    C.tool(),
    id("Card id."),
    C.str("title", "Card name.", "name"),
    C.str("description", "Card description.", "description"),
    C.str("card_type", "Card type: question, model or metric.", "type"),
    C.str("display", "Visualization type, e.g. bar, line, table, scalar.", "display"),
    C.str(
      "query_type",
      "'native' (SQL) or 'query' (MBQL / query builder).",
      (r) => r.query_type ?? queryType(r.dataset_query),
    ),
    C.str("database_id", "Id of the database the card queries.", (r) => r.database_id ?? databaseId(r.dataset_query)),
    C.str("table_id", "Id of the main source table (MBQL cards).", "table_id"),
    C.str("source_card_id", "Id of the card (often a model) this card is built on.", "source_card_id"),
    folderId,
    folderPath,
    owner,
    C.str("owner_id", "Id of the user who created the card.", "creator_id"),
    C.time("created_at", "When the card was created.", "created_at"),
    C.time("updated_at", "When the card was last updated.", "updated_at"),
    C.time(
      "last_viewed_at",
      "Last time the card ran (Metabase's last_used_at; there is no separate last-view time).",
      "last_used_at",
    ),
    C.time("last_used_at", "Last time the card's query ran (Metabase 0.50+).", "last_used_at"),
    C.bigint("view_count", "Count of lifetime views Metabase has recorded for the card.", "view_count"),
    C.url("Web UI link to the question, model or metric.", cardUrl),
    C.bool("archived", "Whether the card is in the trash.", "archived"),
    C.str("dashboard_id", "Dashboard the question is saved in (dashboard questions, Metabase 0.53+).", "dashboard_id"),
    C.int("collection_position", "Pinned position in its collection (NULL = not pinned).", "collection_position"),
    C.bool(
      "is_public",
      "Whether the card has a public sharing link (the link itself is not returned).",
      (r) => r.public_uuid != null || r.public_uuid_prefix != null,
    ),
    C.bool("enable_embedding", "Whether static embedding is enabled.", "enable_embedding"),
    C.int("cache_ttl", "Cache TTL override in hours (NULL = default).", "cache_ttl"),
    C.str("entity_id", "Stable entity id used by serialization.", "entity_id"),
  ],
  requests: (ctx) => cardRequests(ctx),
  enrich: cardEnrich,
  examples: [
    {
      description: "Cards by type and query kind",
      sql: "SELECT card_type, query_type, count(*) AS cards FROM metabase.main.charts WHERE NOT archived GROUP BY ALL ORDER BY cards DESC",
    },
    {
      description: "Most-viewed models",
      sql: "SELECT title, folder_path, view_count FROM metabase.main.charts WHERE card_type = 'model' ORDER BY view_count DESC LIMIT 10",
    },
  ],
};

const TAG_FIELDS = [
  { name: "name", path: "name" },
  { name: "id", path: "id" },
  { name: "type", path: "type" },
  { name: "display_name", path: "displayName" },
  { name: "default_value", path: "default" },
  { name: "required", path: "required", kind: "bool" as const },
];

export const queries: MetabaseTableSpec = {
  name: "queries",
  description: "The query behind each card: native SQL text or MBQL, database, source tables and template tags.",
  title: "Metabase Queries",
  category: "content",
  keywords: "metabase, queries, sql, native query, mbql, query builder, template tags, variables",
  docLlm:
    "One row per card's query (Metabase stores the query on the card, so id = card_id). Columns: tool, id, " +
    "card_id, title, card_type, url, query_type ('native' or 'query' = MBQL), database_id, native_sql (the SQL " +
    "text of native questions, as written, including {{variables}}), template_tags (list of structs: name, id, " +
    "type, display_name, default_value JSON, required), source_table_ids and source_card_ids (every table / " +
    "card an MBQL query reads, joins included; empty for native SQL), mbql_format ('legacy' or 'pmbql' = MBQL 5 " +
    "stages, Metabase 0.57+), dataset_query (the full query as JSON), archived. Use card_tables for table names.",
  docMd:
    "Query definitions: SQL text for native questions, the MBQL JSON for query-builder questions, and the " +
    "tables and cards each MBQL query reads. Native SQL is never parsed.",
  pushdown: "Same as `charts`: `id` (or `card_id`) `= …`, `table_id`, `database_id`, `archived`.",
  columns: [
    C.tool(),
    id("Card id (a card holds exactly one query)."),
    C.str("card_id", "Card id (same as id).", "id", false),
    C.str("title", "Card name.", "name"),
    C.str("card_type", "Card type: question, model or metric.", "type"),
    C.url("Web UI link to the card.", cardUrl),
    C.str("query_type", "'native' (SQL) or 'query' (MBQL).", (r) => r.query_type ?? queryType(r.dataset_query)),
    C.str("database_id", "Database the query runs against.", (r) => r.database_id ?? databaseId(r.dataset_query)),
    C.str("table_id", "Main source table (MBQL).", "table_id"),
    C.str("native_sql", "SQL text of a native question (NULL for MBQL).", (r) => nativeQuery(r.dataset_query)),
    C.structList(
      "template_tags",
      "Variables of a native question: name, id, type, display name, default (JSON), required.",
      TAG_FIELDS,
      (r) => templateTags(r.dataset_query),
    ),
    {
      ...C.strList("source_table_ids", "Ids of every table the MBQL query reads (main source and joins).", (r) => [
        ...new Set(querySources(r.dataset_query).flatMap((s) => (s.tableId != null ? [s.tableId] : []))),
      ]),
    },
    {
      ...C.strList("source_card_ids", "Ids of every card (model / question) the MBQL query reads.", (r) => [
        ...new Set(querySources(r.dataset_query).flatMap((s) => (s.cardId != null ? [s.cardId] : []))),
      ]),
    },
    C.str("mbql_format", "'pmbql' (MBQL 5 stages, Metabase 0.57+) or 'legacy'.", (r) =>
      r.dataset_query && Array.isArray(r.dataset_query.stages) ? "pmbql" : r.dataset_query ? "legacy" : null,
    ),
    C.json("dataset_query", "The full query definition as JSON.", "dataset_query"),
    C.bool("archived", "Whether the card is in the trash.", "archived"),
  ],
  requests: (ctx) => cardRequests(ctx, singleEq(ctx.constraints, "id") ? "id" : "card_id"),
  examples: [
    {
      description: "Native SQL questions that select from ORDERS",
      sql: "SELECT id, title, native_sql FROM metabase.main.queries WHERE query_type = 'native' AND native_sql ILIKE '%orders%' ORDER BY id",
    },
    {
      description: "Questions built on another card (model reuse)",
      sql: "SELECT q.title, src AS source_card_id FROM metabase.main.queries q, unnest(q.source_card_ids) AS t(src) ORDER BY q.title",
    },
  ],
};

export const cardTables: MetabaseTableSpec = {
  name: "card_tables",
  description: "Lineage: the database tables (and source cards) each MBQL card reads, with schema and table names.",
  title: "Metabase Card Lineage",
  category: "lineage",
  keywords: "metabase, lineage, tables, sources, joins, models, dependencies, warehouse",
  docLlm:
    "One row per source of an MBQL card (query-builder questions, models, metrics): the main source and every " +
    "join, in every stage. Columns: card_id, card_title, card_type, role ('source' or 'join'), join_alias, " +
    "stage, table_id, source_card_id (when the source is another card, e.g. a model), database_id, " +
    "database_name, table_schema, table_name, table_display_name, archived. Native SQL cards have no rows (their " +
    "SQL is in queries.native_sql and is not parsed). Join card_id to charts.id; resolve source_card_id chains " +
    "by joining card_tables to itself.",
  docMd:
    "Which warehouse tables each MBQL question, model and metric reads, from Metabase's own table metadata. " +
    "Native SQL questions are not parsed.",
  pushdown: "Same as `charts`: `card_id = …`, `table_id`, `database_id`, `archived`.",
  key: [],
  columns: [
    C.str("card_id", "Id of the question, model or metric whose query reads this source.", "__card_id", false),
    C.str("card_title", "Card name.", "__card_title"),
    C.str("card_type", "Card type: question, model or metric.", "__card_type"),
    C.str("role", "'source' (the stage's main source) or 'join'.", "role", false),
    C.str("join_alias", "Alias of the join (NULL for the main source).", "joinAlias"),
    C.int("stage", "Index (from 0) of the query stage the source belongs to.", "stage"),
    C.str("table_id", "Id of the table read (NULL when the source is a card).", "tableId"),
    C.str("source_card_id", "Id of the card read (NULL when the source is a table).", "cardId"),
    C.str("database_id", "Database of the card.", "__db_id"),
    C.str("database_name", "Name of that database in Metabase.", "__db_name"),
    C.str("table_schema", "Schema of the table read.", "__schema"),
    C.str("table_name", "Name of the table read.", "__table"),
    C.str("table_display_name", "Display name of the table read.", "__table_display"),
    C.bool("archived", "Whether the card is in the trash.", "__archived"),
  ],
  requests: (ctx) => cardRequests(ctx, "card_id"),
  rows: (body) =>
    defaultRows(body).flatMap((card) =>
      querySources(card.dataset_query).map((s) => ({
        ...s,
        __card_id: String(card.id),
        __card_title: card.name,
        __card_type: card.type,
        __archived: card.archived,
        __db_id: idOf(card.database_id ?? databaseId(card.dataset_query)),
      })),
    ),
  enrich: async (ctx, rows) => {
    const [tables, dbs] = await Promise.all([tableInfo(ctx.cfg), databaseNames(ctx.cfg)]);
    return rows.map((r) => {
      const t = r.tableId != null ? tables.get(String(r.tableId)) : undefined;
      const db = r.__db_id ?? t?.dbId ?? null;
      return {
        ...r,
        __db_id: db,
        __db_name: db ? (dbs.get(db) ?? null) : null,
        __schema: t?.schema ?? null,
        __table: t?.name ?? null,
        __table_display: t?.displayName ?? null,
      };
    });
  },
  examples: [
    {
      description: "Which warehouse tables feed each dashboard",
      sql: "SELECT DISTINCT d.dashboard_title, t.table_schema, t.table_name FROM metabase.main.dashboard_cards d JOIN metabase.main.card_tables t ON t.card_id = d.card_id ORDER BY ALL",
    },
    {
      description: "Most-used tables across MBQL questions",
      sql: "SELECT table_name, count(DISTINCT card_id) AS cards FROM metabase.main.card_tables WHERE table_id IS NOT NULL GROUP BY table_name ORDER BY cards DESC",
    },
  ],
};

// ------------------------------------------------------------------------- data

export const connections: MetabaseTableSpec = {
  name: "connections",
  description:
    "Connected databases: engine, host, port and database name — never passwords, keys or other connection secrets.",
  title: "Metabase Databases",
  category: "data",
  keywords: "metabase, databases, connections, data sources, engine, warehouse, sync",
  docLlm:
    "One row per database connected to Metabase (GET /api/database). Columns: tool, id, title (name), " +
    "created_at, updated_at, url, engine (postgres, bigquery-cloud-sdk, snowflake, h2, sqlite …), host, port, " +
    "db_name (database / catalog / project, with any inline credentials or JDBC options stripped), " +
    "description, timezone, is_sample, is_audit (the Usage Analytics database), is_full_sync, is_on_demand, " +
    "auto_run_queries, initial_sync_status, metadata_sync_schedule, cache_field_values_schedule, " +
    "uploads_enabled, dbms_version (flavor + version as JSON), creator_id. Passwords, SSH keys, tunnels, " +
    "service-account JSON and JDBC options are never returned.",
  docMd:
    "Database connections with the shared columns `tool, id, title, created_at, url` (the `data_sources` of " +
    "other tools). Only host, port and database name are read from the connection details.",
  pushdown: "`id = …` reads `/api/database/:id`.",
  columns: [
    C.tool(),
    id("Database id."),
    C.str("title", "Database name in Metabase.", "name"),
    C.time("created_at", "When the connection was added.", "created_at"),
    C.time("updated_at", "When the connection was last updated.", "updated_at"),
    C.url("Admin UI link to the connection.", (r) => `/admin/databases/${enc(String(r.id))}`),
    C.str("engine", "Driver: postgres, mysql, bigquery-cloud-sdk, snowflake, redshift, h2, sqlite …", "engine"),
    C.str("host", "Server host name (no credentials).", (r) => safeDetails(r.details).host),
    C.int("port", "TCP port number of the database server.", (r) => safeDetails(r.details).port),
    C.str(
      "db_name",
      "Database / catalog / project name, with inline credentials and options stripped.",
      (r) => safeDetails(r.details).dbName,
    ),
    C.str("description", "Free-text note an admin wrote about the connection.", "description"),
    C.str("timezone", "Database timezone Metabase detected.", "timezone"),
    C.bool("is_sample", "Whether this is Metabase's Sample Database.", "is_sample"),
    C.bool("is_audit", "Whether this is the internal Usage Analytics database (Pro/Enterprise).", "is_audit"),
    C.bool("is_full_sync", "Whether field values are fully synced.", "is_full_sync"),
    C.bool("is_on_demand", "Whether field values are synced on demand.", "is_on_demand"),
    C.bool("auto_run_queries", "Whether queries run automatically in the query builder.", "auto_run_queries"),
    C.str("initial_sync_status", "Initial sync status: incomplete, complete, aborted.", "initial_sync_status"),
    C.str("metadata_sync_schedule", "Quartz cron of the metadata sync.", "metadata_sync_schedule"),
    C.str("cache_field_values_schedule", "Quartz cron of the field-values scan.", "cache_field_values_schedule"),
    C.bool("uploads_enabled", "Whether CSV uploads go to this database.", "uploads_enabled"),
    C.json("dbms_version", "Database server flavor and version as reported by the driver.", "dbms_version"),
    C.str("creator_id", "Id of the user who added the connection.", "creator_id"),
  ],
  requests: (ctx) => {
    const one = singleEq(ctx.constraints, "id");
    return [isId(one) ? { path: `/database/${one}`, notFoundEmpty: true } : { path: "/database" }];
  },
  examples: [
    {
      description: "Connections by engine",
      sql: "SELECT engine, count(*) AS databases, list(title ORDER BY title) AS names FROM metabase.main.connections GROUP BY engine ORDER BY databases DESC",
    },
  ],
};

export const tables: MetabaseTableSpec = {
  name: "tables",
  description: "Tables Metabase has synced, with schema, visibility, entity type and estimated row counts.",
  title: "Metabase Tables",
  category: "data",
  keywords: "metabase, tables, data model, schema, metadata, sync, visibility",
  docLlm:
    "One row per table in Metabase's data model (GET /api/table). Columns: tool, id, database_id, " +
    "database_name, table_schema, table_name, display_name, description, entity_type (entity/UserTable, " +
    "entity/TransactionTable …), visibility_type (NULL = visible, hidden, technical, cruft), active, " +
    "estimated_row_count, view_count, field_order, initial_sync_status, created_at, updated_at, url. Columns " +
    "of each table are in fields.",
  docMd: "The synced tables of every connected database, with Metabase's curation (display names, visibility).",
  pushdown: "`id = …` reads `/api/table/:id`.",
  columns: [
    C.tool(),
    id("Table id."),
    C.str("database_id", "Id of the connected database (join connections.id).", "db_id"),
    C.str("database_name", "Name of that database in Metabase.", (r) => r.db?.name ?? r.__db_name),
    C.str("table_schema", "Schema (empty or NULL for schemaless databases).", "schema"),
    C.str("table_name", "Table name in the database.", "name"),
    C.str("display_name", "Display name in Metabase.", "display_name"),
    C.str("description", "Curated description.", "description"),
    C.str("entity_type", "Entity type, e.g. entity/UserTable, entity/TransactionTable.", "entity_type"),
    C.str("visibility_type", "NULL (visible), hidden, technical or cruft.", "visibility_type"),
    C.bool("active", "Whether the table still exists in the database.", "active"),
    C.bigint("estimated_row_count", "Row count estimate from the last sync.", "estimated_row_count"),
    C.bigint("view_count", "Times the table has been viewed in Metabase.", "view_count"),
    C.str("field_order", "Column ordering: database, alphabetical, custom or smart.", "field_order"),
    C.str(
      "initial_sync_status",
      "State of the first metadata sync: incomplete, complete or aborted.",
      "initial_sync_status",
    ),
    C.time("created_at", "When Metabase first synced the table.", "created_at"),
    C.time("updated_at", "When the table's metadata last changed.", "updated_at"),
    C.url("Link to the table's data in the Metabase UI.", (r) =>
      r.db_id != null ? `/question#?db=${enc(String(r.db_id))}&table=${enc(String(r.id))}` : null,
    ),
  ],
  requests: (ctx) => {
    const one = singleEq(ctx.constraints, "id");
    return [isId(one) ? { path: `/table/${one}`, notFoundEmpty: true } : { path: "/table" }];
  },
  enrich: async (ctx, rows) => {
    if (rows.every((r) => r.db?.name)) return rows;
    const dbs = await databaseNames(ctx.cfg);
    return rows.map((r) => ({ ...r, __db_name: dbs.get(String(r.db_id)) ?? null }));
  },
  examples: [
    {
      description: "Largest tables by estimated rows",
      sql: "SELECT database_name, table_schema, table_name, estimated_row_count FROM metabase.main.tables WHERE active ORDER BY estimated_row_count DESC NULLS LAST LIMIT 10",
    },
  ],
};

/** Databases to read field metadata from: a pushed database_id, else every database. */
async function databaseIds(ctx: ScanContext): Promise<string[]> {
  const table = singleEq(ctx.constraints, "table_id");
  if (isId(table)) return [`table:${table}`];
  const one = singleEq(ctx.constraints, "database_id");
  if (isId(one)) return [one];
  return defaultRows(await metabaseRequest(ctx.cfg, "/database")).map((r) => String(r.id));
}

export const fields: MetabaseTableSpec = {
  name: "fields",
  description: "Columns of every synced table with base, effective and semantic types and foreign keys.",
  title: "Metabase Fields",
  category: "data",
  keywords: "metabase, fields, columns, semantic types, foreign keys, data model, metadata",
  docLlm:
    "One row per field (column) Metabase knows (GET /api/database/:id/metadata?include_hidden=true, one call " +
    "per database; GET /api/table/:id/query_metadata when table_id is filtered). Columns: tool, id, table_id, " +
    "table_name, table_schema, database_id, name, display_name, description, base_type (type/Integer …), " +
    "effective_type, semantic_type (type/PK, type/FK, type/Email, type/Category …), database_type, is_pk, " +
    "fk_target_field_id, fk_target_table_id, fk_target_field_name, position, visibility_type (normal, " +
    "details-only, sensitive, hidden, retired), active, has_field_values, coercion_strategy, parent_id (nested " +
    "JSON fields). Filter table_id or database_id to read less.",
  docMd: "Every column with Metabase's types and curation; `fk_target_*` resolve foreign keys within the database.",
  pushdown: "`table_id = …` reads one table's metadata; `database_id = …` reads one database.",
  columns: [
    C.tool(),
    id("Field id."),
    C.str("table_id", "Id of the table the field belongs to (join tables.id).", "table_id"),
    C.str("table_name", "Name of that table in the database.", "__table_name"),
    C.str("table_schema", "Schema of that table (empty for schemaless databases).", "__table_schema"),
    C.str("database_id", "Id of the connected database (join connections.id).", "__db_id"),
    C.str("name", "Column name in the database.", "name"),
    C.str("display_name", "Display name in Metabase.", "display_name"),
    C.str("description", "Curated description.", "description"),
    C.str("base_type", "Metabase base type, e.g. type/Integer, type/Text, type/DateTime.", "base_type"),
    C.str("effective_type", "Effective type after coercion.", "effective_type"),
    C.str("semantic_type", "Semantic type, e.g. type/PK, type/FK, type/Email, type/Category.", "semantic_type"),
    C.str("database_type", "Native database column type.", "database_type"),
    C.bool(
      "is_pk",
      "Whether the field is the table's primary key (semantic type type/PK).",
      (r) => r.semantic_type === "type/PK",
    ),
    C.str("fk_target_field_id", "Field this foreign key points at.", "fk_target_field_id"),
    C.str("fk_target_table_id", "Table of the foreign key target.", "__fk_table_id"),
    C.str("fk_target_field_name", "Name of the foreign key target field.", "__fk_field_name"),
    C.int("position", "Ordinal position of the column in its table, counted from 0.", "position"),
    C.str("visibility_type", "normal, details-only, sensitive, hidden or retired.", "visibility_type"),
    C.bool("active", "Whether the column still exists.", "active"),
    C.str("has_field_values", "Filter widget source: list, search, auto-list or none.", "has_field_values"),
    C.str("coercion_strategy", "Type coercion applied, e.g. Coercion/UNIXSeconds->DateTime.", "coercion_strategy"),
    C.str("parent_id", "Parent field of a nested (JSON-unfolded) field.", "parent_id"),
  ],
  fanout: {
    parents: databaseIds,
    child: (p) =>
      p.startsWith("table:")
        ? {
            path: `/table/${enc(p.slice(6))}/query_metadata`,
            query: { include_hidden_fields: true, include_sensitive_fields: true },
            notFoundEmpty: true,
          }
        : {
            path: `/database/${enc(p)}/metadata`,
            query: { include_hidden: true, include_sensitive_fields: true },
            notFoundEmpty: true,
          },
  },
  rows: (body) => {
    const b = body as Row | null;
    if (!b) return [];
    const tbls: Row[] = Array.isArray(b.tables) ? b.tables : [b];
    const byField = new Map<string, Row>();
    for (const t of tbls) for (const f of t.fields ?? []) byField.set(String(f.id), { ...f, __t: t });
    return tbls.flatMap((t) =>
      (t.fields ?? []).map((f: Row) => {
        const target = f.fk_target_field_id != null ? byField.get(String(f.fk_target_field_id)) : undefined;
        return {
          ...f,
          table_id: f.table_id ?? t.id,
          __table_name: t.name,
          __table_schema: t.schema,
          __db_id: idOf(t.db_id ?? b.id),
          __fk_table_id: target ? idOf(target.table_id ?? target.__t?.id) : (f.target?.table_id ?? null),
          __fk_field_name: target?.name ?? f.target?.name ?? null,
        };
      }),
    );
  },
  examples: [
    {
      description: "Foreign keys between tables",
      sql: "SELECT table_name, name, fk_target_field_name FROM metabase.main.fields WHERE semantic_type = 'type/FK' ORDER BY table_name, name",
    },
    {
      description: "Columns per semantic type in one database",
      sql: "SELECT semantic_type, count(*) AS fields FROM metabase.main.fields WHERE database_id = '1' GROUP BY semantic_type ORDER BY fields DESC",
    },
  ],
};

export const segments: MetabaseTableSpec = {
  name: "segments",
  description: "Segments: saved, named filters on a table.",
  title: "Metabase Segments",
  category: "data",
  keywords: "metabase, segments, saved filters, data model, definitions",
  docLlm:
    "One row per segment (GET /api/segment): tool, id, title, description, table_id, database_id, " +
    "definition_description (human-readable filter, e.g. 'Filtered by Total is greater than 100'), definition " +
    "(MBQL JSON), archived, owner, owner_id, created_at, updated_at, url, entity_id.",
  docMd: "Saved segments (named filters) with their definition.",
  columns: [
    C.tool(),
    id("Segment id."),
    C.str("title", "Segment name.", "name"),
    C.str("description", "Free-text explanation of what the segment selects.", "description"),
    C.str("table_id", "Table the segment filters.", "table_id"),
    C.str("database_id", "Database of the table.", (r) => databaseId(r.definition)),
    C.str("definition_description", "Human-readable form of the filter.", "definition_description"),
    C.json("definition", "The filter definition (MBQL) as JSON.", "definition"),
    C.bool("archived", "Whether the segment is retired.", "archived"),
    owner,
    C.str("owner_id", "Id of the creator.", "creator_id"),
    C.time("created_at", "When the segment was created.", "created_at"),
    C.time("updated_at", "When the segment was last updated.", "updated_at"),
    C.url("Link to the segment in the data reference.", (r) => `/reference/segments/${enc(String(r.id))}`),
    C.str("entity_id", "Stable entity id used by serialization.", "entity_id"),
  ],
  requests: () => [{ path: "/segment" }],
  enrich: async (ctx, rows) =>
    withFolderAndOwner(
      ctx.cfg,
      rows.map((r) => ({ ...r, __owner: ownerName(r) })),
      null,
      (r) => r.creator_id,
    ),
  examples: [
    {
      description: "Segments per table",
      sql: "SELECT s.title, s.definition_description, t.table_name FROM metabase.main.segments s JOIN metabase.main.tables t ON t.id = s.table_id ORDER BY s.title",
    },
  ],
};

// ------------------------------------------------------------------------ admin

export const users: MetabaseTableSpec = {
  name: "users",
  description: "Metabase users with group memberships, admin flag and last login — never credentials.",
  title: "Metabase Users",
  category: "admin",
  keywords: "metabase, users, people, accounts, admins, groups, sso, last login",
  docLlm:
    "One row per Metabase user, active and deactivated (GET /api/user?status=all, paged). Columns: tool, id, " +
    "url, display_name, email, first_name, last_name, is_active, is_superuser (admin), last_login, " +
    "created_at (date joined), updated_at, sso_source (google, ldap, saml, jwt or NULL), group_ids (list), " +
    "personal_collection_id, locale. Passwords, API keys, session ids, login attributes and JWT attributes are " +
    "never returned. WHERE is_active = true/false and id = … push down.",
  docMd: "Users and their groups with the shared columns `tool, id, url` (+ `display_name`, `email`).",
  pushdown: "`id = …` reads `/api/user/:id`; `is_active` picks `status=active` / `status=deactivated`.",
  columns: [
    C.tool(),
    id("User id."),
    C.url("Admin UI link to the user.", (r) => `/admin/people/${enc(String(r.id))}`),
    C.str(
      "display_name",
      "Full name (common_name).",
      (r) => r.common_name ?? ([r.first_name, r.last_name].filter(Boolean).join(" ") || null),
    ),
    C.str("email", "Email address (the login).", "email"),
    C.str("first_name", "Given name as entered in Metabase.", "first_name"),
    C.str("last_name", "Family name as entered in Metabase.", "last_name"),
    C.bool("is_active", "False when the account is deactivated.", "is_active"),
    C.bool("is_superuser", "Whether the user is an administrator.", "is_superuser"),
    C.time("last_login", "Last login time.", "last_login"),
    C.time("created_at", "When the account was created (date_joined).", "date_joined"),
    C.time("updated_at", "When the account was last updated.", "updated_at"),
    C.str("sso_source", "Single sign-on source (google, ldap, saml, jwt) or NULL for password logins.", "sso_source"),
    {
      ...C.strList("group_ids", "Ids of the groups the user belongs to (admins see these).", (r) =>
        Array.isArray(r.group_ids)
          ? r.group_ids
          : Array.isArray(r.user_group_memberships)
            ? r.user_group_memberships.map((m: Row) => m.id)
            : null,
      ),
    },
    C.str("personal_collection_id", "Id of the user's personal collection.", "personal_collection_id"),
    C.str("locale", "Preferred locale (NULL = site default).", "locale"),
  ],
  requests: (ctx) => {
    const one = singleEq(ctx.constraints, "id");
    if (isId(one)) return [{ path: `/user/${one}`, notFoundEmpty: true }];
    const active = boolValue(ctx.constraints, "is_active");
    const status = active === true ? "active" : active === false ? "deactivated" : "all";
    return [{ path: "/user", paged: true, query: { status } }];
  },
  examples: [
    {
      description: "Admins and when they last logged in",
      sql: "SELECT display_name, email, last_login FROM metabase.main.users WHERE is_superuser AND is_active ORDER BY last_login DESC NULLS LAST",
    },
    {
      description: "Users who never logged in",
      sql: "SELECT email, created_at FROM metabase.main.users WHERE is_active AND last_login IS NULL ORDER BY created_at",
    },
  ],
};

export const groups: MetabaseTableSpec = {
  name: "groups",
  description: "Permission groups with member counts.",
  title: "Metabase Groups",
  category: "admin",
  keywords: "metabase, groups, permissions, members, administrators",
  docLlm:
    "One row per permission group (GET /api/permissions/group): tool, id, title, member_count, " +
    "magic_group_type ('admin' = Administrators, 'all-internal-users' = All Users, NULL for custom groups), " +
    "is_tenant_group, entity_id. Members: users.group_ids. Data access: group_permissions.",
  docMd: "Permission groups and how many members each has.",
  columns: [
    C.tool(),
    id("Group id."),
    C.str("title", "Name of the permission group (NULL for groups the API hides).", "name"),
    C.bigint("member_count", "Number of members.", "member_count"),
    C.str("magic_group_type", "'admin', 'all-internal-users' or NULL for custom groups.", "magic_group_type"),
    C.bool("is_tenant_group", "Whether the group belongs to a tenant (multi-tenant embedding).", "is_tenant_group"),
    C.str("entity_id", "Stable entity id.", "entity_id"),
  ],
  requests: () => [{ path: "/permissions/group" }],
  examples: [
    {
      description: "Groups by size",
      sql: "SELECT title, member_count FROM metabase.main.groups ORDER BY member_count DESC",
    },
  ],
};

/** A permission value: strings as-is, nested (per-schema / per-table) grants as 'granular'. */
function permValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const s = (v as Row).schemas;
    if (typeof s === "string") return s;
    return "granular";
  }
  return String(v);
}

export const groupPermissions: MetabaseTableSpec = {
  name: "group_permissions",
  description: "Data permissions summary: what each group may view, query, download and curate per database.",
  title: "Metabase Data Permissions",
  category: "admin",
  keywords: "metabase, permissions, data access, groups, view data, create queries, download, governance",
  docLlm:
    "One row per (group, database) in the data permissions graph (GET /api/permissions/graph). Columns: " +
    "group_id, group_name, database_id, database_name, view_data (unrestricted, blocked, " +
    "legacy-no-self-service, sandboxed, impersonated …), create_queries (query-builder-and-native, " +
    "query-builder, no, or 'granular' when set per schema/table), download (full, limited, none or " +
    "'granular'), data_model, details, permissions (the raw grant as JSON). Older Metabase versions use " +
    "`data.native` / `data.schemas`; those come through in permissions.",
  docMd: "Who can see and query each database, one row per group and database.",
  key: ["group_id", "database_id"],
  columns: [
    C.str("group_id", "Id of the permission group (join groups.id).", "group_id", false),
    C.str("group_name", "Name of the permission group (NULL for groups the API hides).", "__group_name"),
    C.str("database_id", "Id of the connected database (join connections.id).", "database_id", false),
    C.str("database_name", "Name of that database in Metabase.", "__db_name"),
    C.str("view_data", "View-data level (unrestricted, blocked, sandboxed, impersonated …).", (r) =>
      permValue(r.perms?.["view-data"]),
    ),
    C.str("create_queries", "Query level: query-builder-and-native, query-builder, no, or granular.", (r) =>
      permValue(r.perms?.["create-queries"]),
    ),
    C.str("download", "Download level: full, limited, none, or granular.", (r) => permValue(r.perms?.download)),
    C.str("data_model", "Data-model curation rights (all, none, or granular).", (r) =>
      permValue(r.perms?.["data-model"]),
    ),
    C.str("details", "Whether the group may edit the connection details (yes / no).", (r) =>
      permValue(r.perms?.details),
    ),
    C.json("permissions", "The full grant for this group and database as JSON.", "perms"),
  ],
  requests: () => [{ path: "/permissions/graph" }],
  rows: (body) => {
    const g = ((body as Row | null)?.groups ?? {}) as Row;
    return Object.entries(g).flatMap(([gid, dbs]) =>
      Object.entries((dbs ?? {}) as Row).map(([dbid, perms]) => ({ group_id: gid, database_id: dbid, perms })),
    );
  },
  enrich: async (ctx, rows) => {
    const [gs, dbs] = await Promise.all([
      metabaseRequest(ctx.cfg, "/permissions/group").then(
        (b) => new Map(defaultRows(b).map((r) => [String(r.id), asStr(r.name)])),
      ),
      databaseNames(ctx.cfg),
    ]);
    return rows.map((r) => ({
      ...r,
      __group_name: gs.get(r.group_id) ?? null,
      __db_name: dbs.get(r.database_id) ?? null,
    }));
  },
  examples: [
    {
      description: "Groups that can write native SQL, per database",
      sql: "SELECT group_name, database_name FROM metabase.main.group_permissions WHERE create_queries = 'query-builder-and-native' ORDER BY ALL",
    },
  ],
};

// --------------------------------------------------------------------- delivery

const SCHEDULE_FIELDS = [
  { name: "channel_type", path: "channel_type" },
  { name: "schedule_type", path: "schedule_type" },
  { name: "schedule_day", path: "schedule_day" },
  { name: "schedule_hour", path: "schedule_hour", kind: "int" as const },
  { name: "schedule_frame", path: "schedule_frame" },
  { name: "enabled", path: "enabled", kind: "bool" as const },
];

const recipientCols: Col[] = [
  C.bigint(
    "recipient_count",
    "Number of recipients across channels (users, groups and external addresses).",
    "__rc.recipient_count",
  ),
  C.bigint("user_recipient_count", "Count of recipients who are Metabase users.", "__rc.user_recipient_count"),
  C.bigint(
    "external_recipient_count",
    "Recipients given as raw email addresses (or other raw values).",
    "__rc.external_recipient_count",
  ),
  C.strList(
    "recipient_domains",
    "Distinct email domains of the recipients (addresses are never returned).",
    "__rc.recipient_domains",
  ),
];

/** Pulse channels → recipient summary. */
function pulseRecipients(channels: unknown) {
  const emails: (string | null)[] = [];
  let users = 0;
  let external = 0;
  for (const ch of Array.isArray(channels) ? (channels as Row[]) : []) {
    for (const r of Array.isArray(ch.recipients) ? (ch.recipients as Row[]) : []) {
      emails.push(asStr(r.email));
      if (r.id != null) users++;
      else external++;
    }
  }
  return maskRecipients(emails, users, 0, external);
}

export const subscriptions: MetabaseTableSpec = {
  name: "subscriptions",
  description:
    "Dashboard subscriptions (scheduled email / Slack deliveries); recipients reduced to counts and domains.",
  title: "Metabase Dashboard Subscriptions",
  category: "delivery",
  keywords: "metabase, subscriptions, pulses, schedules, email, slack, delivery, recipients",
  docLlm:
    "One row per dashboard subscription (GET /api/pulse, live and archived). Columns: tool, id, title, " +
    "dashboard_id, folder_id, owner, owner_id, created_at, updated_at, archived, skip_if_empty, card_ids (cards " +
    "included), channel_types (email, slack, http), schedules (list of structs: channel_type, schedule_type " +
    "hourly/daily/weekly/monthly, schedule_day, schedule_hour, schedule_frame, enabled), recipient_count, " +
    "user_recipient_count, external_recipient_count, recipient_domains (distinct email domains), url. " +
    "Addresses, Slack channels and webhook URLs are never returned.",
  docMd: "Scheduled dashboard deliveries. Recipients are summarised: counts and email domains only.",
  pushdown: "`dashboard_id = …` and `archived` become API parameters.",
  columns: [
    C.tool(),
    id("Subscription (pulse) id."),
    C.str("title", "Subscription name (usually the dashboard name).", "name"),
    C.str("dashboard_id", "Dashboard delivered.", "dashboard_id"),
    folderId,
    owner,
    C.str("owner_id", "Id of the creator.", "creator_id"),
    C.time("created_at", "When the subscription was created.", "created_at"),
    C.time("updated_at", "When it was last updated.", "updated_at"),
    C.bool("archived", "Whether the subscription is archived.", "archived"),
    C.bool("skip_if_empty", "Skip delivery when every card is empty.", "skip_if_empty"),
    C.strList("card_ids", "Cards included in the delivery.", (r) =>
      Array.isArray(r.cards) ? r.cards.map((c: Row) => c.id) : null,
    ),
    C.strList("channel_types", "Delivery channels (email, slack, http).", (r) =>
      Array.isArray(r.channels) ? [...new Set(r.channels.map((c: Row) => c.channel_type))].sort() : null,
    ),
    C.structList(
      "schedules",
      "Schedule per channel: type, day, hour, frame and whether it is enabled.",
      SCHEDULE_FIELDS,
      "channels",
    ),
    ...recipientCols,
    C.url("Web UI link to the dashboard.", (r) =>
      r.dashboard_id != null ? `/dashboard/${enc(String(r.dashboard_id))}` : null,
    ),
  ],
  requests: (ctx) => {
    const dash = singleEq(ctx.constraints, "dashboard_id");
    const q = { dashboard_id: isId(dash) ? dash : undefined };
    return archivedPhases(ctx, { path: "/pulse", query: q }, { path: "/pulse", query: { ...q, archived: true } });
  },
  rows: (body) => defaultRows(body).map((r) => ({ ...r, __rc: pulseRecipients(r.channels), __owner: ownerName(r) })),
  enrich: async (ctx, rows) => withFolderAndOwner(ctx.cfg, rows, null, (r) => r.creator_id),
  examples: [
    {
      description: "Subscriptions that send outside the company domain",
      sql: "SELECT title, recipient_domains FROM metabase.main.subscriptions WHERE NOT archived AND len(list_filter(recipient_domains, lambda d: d <> 'example.com')) > 0 ORDER BY title",
    },
  ],
};

/** A notification (0.54+) or legacy alert → recipient summary. */
function alertRecipients(r: Row) {
  const emails: (string | null)[] = [];
  let users = 0;
  let groups = 0;
  let external = 0;
  if (Array.isArray(r.handlers)) {
    for (const h of r.handlers as Row[]) {
      for (const rc of Array.isArray(h.recipients) ? (h.recipients as Row[]) : []) {
        if (rc.type === "notification-recipient/user") {
          users++;
          emails.push(asStr(rc.user?.email));
        } else if (rc.type === "notification-recipient/group") groups++;
        else {
          external++;
          emails.push(asStr(rc.details?.value));
        }
      }
    }
  } else {
    for (const ch of Array.isArray(r.channels) ? (r.channels as Row[]) : []) {
      for (const rc of Array.isArray(ch.recipients) ? (ch.recipients as Row[]) : []) {
        emails.push(asStr(rc.email));
        if (rc.id != null) users++;
        else external++;
      }
    }
  }
  return maskRecipients(emails, users, groups, external);
}

/** Normalise a notification (0.54+) and a legacy /api/alert row to one shape. */
function alertRow(r: Row): Row {
  if (r.payload_type !== undefined) {
    const p: Row = r.payload ?? {};
    return {
      ...r,
      __card_id: p.card_id ?? p.card?.id,
      __card_title: p.card?.name ?? null,
      __condition: p.send_condition,
      __send_once: p.send_once,
      __active: r.active,
      __schedules: (r.subscriptions ?? []).map((s: Row) => s.cron_schedule ?? s.event_name ?? s.type),
      __channels: [
        ...new Set((r.handlers ?? []).map((h: Row) => String(h.channel_type ?? "").replace(/^channel\//, ""))),
      ].sort(),
      __rc: alertRecipients(r),
      __owner: ownerName(r),
    };
  }
  const condition = r.alert_condition === "goal" ? (r.alert_above_goal ? "goal_above" : "goal_below") : "has_result";
  return {
    ...r,
    __card_id: r.card?.id,
    __card_title: r.card?.name ?? null,
    __condition: condition,
    __send_once: r.alert_first_only,
    __active: r.archived === undefined ? null : !r.archived,
    __schedules: (r.channels ?? []).map((c: Row) =>
      [c.schedule_type, c.schedule_day, c.schedule_hour != null ? `${c.schedule_hour}h` : null]
        .filter(Boolean)
        .join(" "),
    ),
    __channels: [...new Set((r.channels ?? []).map((c: Row) => String(c.channel_type)))].sort(),
    __rc: alertRecipients(r),
    __owner: ownerName(r),
  };
}

export const alerts: MetabaseTableSpec = {
  name: "alerts",
  description:
    "Question alerts (notify when a question returns rows or crosses a goal); recipients reduced to counts and domains.",
  title: "Metabase Alerts",
  category: "delivery",
  keywords: "metabase, alerts, notifications, goals, email, slack, recipients",
  docLlm:
    "One row per question alert. Metabase 0.54+ reads GET /api/notification?payload_type=notification/card " +
    "(inactive included); older versions GET /api/alert. Columns: tool, id, card_id, card_title, " +
    "send_condition (has_result, goal_above, goal_below), send_once, active, owner, owner_id, created_at, " +
    "updated_at, cron_schedules (cron expressions, or 'daily 9h' style for legacy alerts), channel_types (email, " +
    "slack, http), recipient_count, user_recipient_count, group_recipient_count, external_recipient_count, " +
    "recipient_domains, url. Recipient addresses and channels are never returned.",
  docMd: "Alerts on questions with their condition and schedule. Recipients are summarised.",
  columns: [
    C.tool(),
    id("Alert (notification) id."),
    C.str("card_id", "Question the alert watches.", "__card_id"),
    C.str("card_title", "Name of the question (when Metabase includes it).", "__card_title"),
    C.str("send_condition", "has_result, goal_above or goal_below.", "__condition"),
    C.bool("send_once", "Whether the alert fires only once.", "__send_once"),
    C.bool("active", "Whether the alert is active.", "__active"),
    owner,
    C.str("owner_id", "Id of the creator.", "creator_id"),
    C.time("created_at", "When the alert was created.", "created_at"),
    C.time("updated_at", "When it was last updated.", "updated_at"),
    C.strList(
      "cron_schedules",
      "Schedules: Quartz cron expressions (0.54+) or 'daily 9h' for legacy alerts.",
      "__schedules",
    ),
    C.strList("channel_types", "Delivery channels (email, slack, http).", "__channels"),
    C.bigint("recipient_count", "Number of recipients (users, groups and external addresses).", "__rc.recipient_count"),
    C.bigint("user_recipient_count", "Count of recipients who are Metabase users.", "__rc.user_recipient_count"),
    C.bigint(
      "group_recipient_count",
      "Count of recipients that are whole permission groups.",
      "__rc.group_recipient_count",
    ),
    C.bigint("external_recipient_count", "Raw email addresses (or other raw values).", "__rc.external_recipient_count"),
    C.strList("recipient_domains", "Distinct email domains of the recipients.", "__rc.recipient_domains"),
    C.url("Web UI link to the question.", (r) =>
      r.__card_id != null ? `/question/${enc(String(r.__card_id))}` : null,
    ),
  ],
  requests: () => [
    {
      path: "/notification",
      query: { payload_type: "notification/card", include_inactive: true },
      fallback: { path: "/alert" },
    },
  ],
  rows: (body) => defaultRows(body).map(alertRow),
  enrich: async (ctx, rows) => {
    const out = await withFolderAndOwner(ctx.cfg, rows, null, (r) => r.creator_id);
    if (!out.some((r) => r.__card_title == null && r.__card_id != null)) return out;
    // Notification payloads may omit the card name: look it up once.
    const cards = defaultRows(await metabaseRequest(ctx.cfg, "/card", { query: { f: "all" } }));
    const names = new Map(cards.map((c) => [String(c.id), asStr(c.name)]));
    return out.map((r) => ({ ...r, __card_title: r.__card_title ?? names.get(String(r.__card_id)) ?? null }));
  },
  examples: [
    {
      description: "Active alerts and who receives them",
      sql: "SELECT card_title, send_condition, cron_schedules, recipient_count, recipient_domains FROM metabase.main.alerts WHERE active ORDER BY card_title",
    },
  ],
};

// --------------------------------------------------------------------- history

/** Parents of the revisions fan-out: `entity:id` pairs, honouring pushdown. */
async function revisionParents(ctx: ScanContext): Promise<string[]> {
  const kind = singleEq(ctx.constraints, "entity_type");
  const one = singleEq(ctx.constraints, "entity_id");
  const kinds = kind
    ? [kind].filter((k) => ["card", "dashboard", "segment"].includes(k))
    : ["dashboard", "card", "segment"];
  if (isId(one)) return kinds.map((k) => `${k}:${one}`);
  const out: string[] = [];
  for (const k of kinds) {
    const path = k === "segment" ? "/segment" : `/${k}`;
    const body = await metabaseRequest(ctx.cfg, path, { query: k === "segment" ? undefined : { f: "all" } });
    out.push(...defaultRows(body).map((r) => `${k}:${r.id}`));
  }
  return out;
}

export const revisions: MetabaseTableSpec = {
  name: "revisions",
  description: "Revision history of dashboards, cards and segments: who changed what, and when.",
  title: "Metabase Revision History",
  category: "usage",
  keywords: "metabase, revisions, history, audit, changes, edits, versions",
  docLlm:
    "One row per revision (GET /api/revision?entity=…&id=…, one call per object). Columns: tool, entity_type " +
    "(dashboard, card, segment), entity_id, id (revision id), changed_at, user_id, user_name, description " +
    "(e.g. 'renamed this', 'added a description.'), message, is_creation, is_reversion, " +
    "has_multiple_changes, diff (before/after JSON), metabase_version. Without filters it reads every live " +
    "dashboard, card and segment — filter entity_type and entity_id to read one object.",
  docMd: "Who changed which dashboard, question or segment, and how.",
  pushdown: "`entity_type = …` limits the object kinds; `entity_id = …` reads only that object.",
  key: ["entity_type", "entity_id", "id"],
  columns: [
    C.tool(),
    C.ctx("entity_type", "Kind of object: dashboard, card or segment.", "entity_type"),
    C.ctx("entity_id", "Id of the object.", "entity_id"),
    id("Revision id."),
    C.time("changed_at", "When the change was made.", "timestamp"),
    C.str("user_id", "Id of the user who made the change.", "user.id"),
    C.str("user_name", "Name of the user who made the change.", (r) => r.user?.common_name ?? null),
    C.str("description", "Summary of the change, e.g. 'renamed this'.", "description"),
    C.str("message", "Optional revision message.", "message"),
    C.bool("is_creation", "Whether this revision created the object.", "is_creation"),
    C.bool("is_reversion", "Whether this revision reverted to an earlier one.", "is_reversion"),
    C.bool("has_multiple_changes", "Whether several properties changed at once.", "has_multiple_changes"),
    C.json("diff", "Before / after values of the changed properties.", "diff"),
    C.str("metabase_version", "Metabase version that recorded the revision.", "metabase_version"),
  ],
  fanout: {
    parents: revisionParents,
    child: (p) => {
      const [kind, oid] = p.split(":") as [string, string];
      return {
        path: "/revision",
        query: { entity: kind, id: oid },
        ctx: { entity_type: kind, entity_id: oid },
        notFoundEmpty: true,
      };
    },
  },
  examples: [
    {
      description: "Most-edited dashboards",
      sql: "SELECT entity_id, count(*) AS edits, max(changed_at) AS last_edit FROM metabase.main.revisions WHERE entity_type = 'dashboard' GROUP BY entity_id ORDER BY edits DESC",
    },
    {
      description: "History of one question",
      sql: "SELECT changed_at, user_name, description FROM metabase.main.revisions WHERE entity_type = 'card' AND entity_id = '41' ORDER BY changed_at",
    },
  ],
};

export const RESOURCE_SPECS: MetabaseTableSpec[] = [
  folders,
  dashboards,
  dashboardCards,
  dashboardTabs,
  charts,
  queries,
  cardTables,
  connections,
  tables,
  fields,
  segments,
  users,
  groups,
  groupPermissions,
  subscriptions,
  alerts,
  revisions,
];

export const RESOURCE_TABLES: TableDescriptor[] = RESOURCE_SPECS.map(defineMetabaseCatalogTable);
