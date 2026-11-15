/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "metabase";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-metabase";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "content",
    title: "Content",
    description:
      "Collections, dashboards, dashboard cards and tabs, saved questions / models / metrics and their queries.",
  },
  { name: "lineage", title: "Lineage", description: "The tables and cards each query-builder question reads." },
  { name: "data", title: "Data Model", description: "Connected databases, synced tables, fields and segments." },
  { name: "admin", title: "Administration", description: "Users, groups and data permissions." },
  {
    name: "delivery",
    title: "Subscriptions and Alerts",
    description: "Dashboard subscriptions and question alerts (recipients masked).",
  },
  {
    name: "usage",
    title: "Usage and History",
    description: "Edition, view counts, Usage Analytics view and query logs, recent views and revision history.",
  },
  { name: "results", title: "Results", description: "Run a saved question and get typed rows." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Metabase API reference](https://www.metabase.com/docs/latest/api) — the endpoints this worker reads\n" +
  "- [API keys](https://www.metabase.com/docs/latest/people-and-groups/api-keys) — x-api-key authentication\n" +
  "- [Usage analytics](https://www.metabase.com/docs/latest/usage-and-performance-tools/usage-analytics) — the View log and Query log models behind content_usage and query_history (Pro/Enterprise)\n" +
  "- [Data permissions](https://www.metabase.com/docs/latest/permissions/data) — the levels in group_permissions";

export const CATALOG_COMMENT =
  "Metabase metadata and usage as SQL: collections, dashboards, questions, models, metrics, queries, lineage, databases, users, permissions, subscriptions, alerts and usage, read-only.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a Metabase site (OSS self-hosted, Pro / Enterprise, or Metabase Cloud) through its " +
  "REST API. Reach for it to inventory BI content (folders = collections with full paths, dashboards with " +
  "filter parameters, dashboard_cards and dashboard_tabs, charts = saved questions / models / metrics, queries " +
  "with native SQL text or MBQL), trace lineage (card_tables: the tables and cards each MBQL question reads, " +
  "with schema and table names; native SQL is not parsed), audit the data model (connections without " +
  "passwords, tables, fields with semantic types and foreign keys, segments) and access (users without " +
  "credentials, groups, group_permissions), review delivery (subscriptions and alerts with recipients masked " +
  "to counts and email domains), measure usage (content_usage: per-day views from Usage Analytics on " +
  "Pro/Enterprise, lifetime counters on OSS; query_history: the Usage Analytics query log; recent_views; " +
  "revisions; instance tells which edition and usage source apply), and fetch results with " +
  "run_card(card_id, parameters := '{...}'). Everything needs a `metabase` DuckDB secret: BASE_URL plus " +
  "API_KEY (sent as x-api-key) or USERNAME / PASSWORD (a session login). Content tables share columns with " +
  "the Looker and Tableau workers (tool, id, title, folder_path, owner, created_at, updated_at, " +
  "last_viewed_at, view_count, url) so they UNION across BI tools. Docs: https://www.metabase.com/docs/latest/api .";

export const CATALOG_DOC_MD =
  "# Metabase\n\n" +
  "Query a Metabase site from DuckDB: collections, dashboards and their cards and tabs, saved questions, " +
  "models and metrics with their SQL or MBQL, MBQL lineage to tables, databases, tables, fields, segments, " +
  "users, groups, data permissions, subscriptions, alerts, revision history and usage. Read-only.\n\n" +
  "Create a `metabase` secret with your site URL (`BASE_URL`) and an `API_KEY` (or `USERNAME` and " +
  "`PASSWORD`). Per-day usage and the query log come from Usage Analytics on Pro/Enterprise; OSS reports " +
  "lifetime view counters. Connection passwords and recipients' addresses are never returned.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Metabase REST collections as tables, plus run_card. Content: folders (collections), dashboards, " +
  "dashboard_cards, dashboard_tabs, charts (cards: questions, models, metrics), queries. Lineage: card_tables. " +
  "Data model: connections, tables, fields, segments. Admin: users, groups, group_permissions. Delivery: " +
  "subscriptions, alerts. Usage: instance, content_usage, query_history (Pro/Enterprise), recent_views, " +
  "revisions. Results: run_card(card_id, parameters := '{...}'). Per-dashboard and per-object tables " +
  "(dashboard_cards, dashboard_tabs, fields, revisions) make one API call per parent, so filter " +
  "dashboard_id / database_id / entity_id when you can. All objects need a `metabase` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Metabase content, lineage, data model, administration, delivery and usage as tables; `run_card` returns " +
  "typed results.\n\n" +
  "All objects need a `metabase` secret; id, archived, database and dashboard filters push down into the " +
  "API, and time windows into Usage Analytics queries.";

export const AGENT_TEST_TASKS = [
  { name: "most_viewed_dashboard", prompt: "Which Metabase dashboard has the most views?" },
  { name: "emea_questions", prompt: "List the titles of the cards in the /Marketing/EMEA collection." },
  { name: "native_questions", prompt: "Which saved questions are written in native SQL?" },
  { name: "models", prompt: "Which Metabase cards are models?" },
  { name: "archived_cards", prompt: "Which cards are in the trash (archived)?" },
  { name: "deactivated_users", prompt: "Which Metabase users are deactivated? Give their emails." },
  { name: "admins", prompt: "Which Metabase users are administrators?" },
  { name: "connection_engines", prompt: "What engine does each connected database use?" },
  { name: "revenue_lineage", prompt: "Which tables does the 'Revenue by Category' question read?" },
  { name: "dashboard_tabs", prompt: "How many cards are on each tab of the Sales Overview dashboard?" },
  {
    name: "external_subscriptions",
    prompt: "Which dashboard subscriptions send to email domains other than example.com?",
  },
  { name: "alert_cards", prompt: "Which questions have alerts on them?" },
  { name: "native_sql_groups", prompt: "Which groups may write native SQL against the Sample Database?" },
  { name: "fk_orders", prompt: "Which foreign keys does the ORDERS table have, and what do they point at?" },
  { name: "edition", prompt: "Which Metabase version and edition is this, and is Usage Analytics available?" },
  { name: "card_41_history", prompt: "Who changed card 41, and what did they change?" },
  {
    name: "run_card_gizmo",
    prompt: "Run the 'Orders by Category (SQL)' question for the Gizmo category: how many orders?",
  },
  { name: "segments", prompt: "What segments are defined, and on which table?" },
  { name: "recent_dashboards", prompt: "Which dashboards have I viewed recently in Metabase?" },
  { name: "usage_top_card", prompt: "Which saved question has the most views according to Metabase's usage data?" },
  { name: "sales_overview_cards", prompt: "Which questions are on the Sales Overview dashboard?" },
  { name: "marketing_subcollections", prompt: "Which collections sit directly inside the Marketing collection?" },
  { name: "group_sizes", prompt: "How many members does each Metabase permission group have?" },
  { name: "sql_of_question", prompt: "Show the SQL of the 'Orders by Category (SQL)' question." },
  {
    name: "failed_queries",
    prompt: "How many Metabase queries failed in the last 7 days? (Pro/Enterprise Usage Analytics)",
  },
];

/** Bind-only probes: each binds the table and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "dashboards_columns",
    description: "The dashboards columns (binds only; create a metabase secret and drop LIMIT 0 for rows)",
    sql: "SELECT tool, id, title, folder_path, owner, view_count, url FROM metabase.main.dashboards LIMIT 0",
  },
  {
    name: "charts_columns",
    description: "The charts columns (binds only; create a metabase secret and drop LIMIT 0 for rows)",
    sql: "SELECT id, title, card_type, query_type, folder_path FROM metabase.main.charts LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Metabase BI Metadata",
  "vgi.subtitle":
    "Metabase collections, dashboards, questions, models, lineage, permissions, subscriptions and usage as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "metabase, bi, business intelligence, dashboards, questions, models, metrics, collections, lineage, usage analytics",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Metabase API",
  domain: "business-intelligence",
  "vgi.keywords": keywordsArray("metabase, dashboards, questions, collections, lineage, users, permissions, usage"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
