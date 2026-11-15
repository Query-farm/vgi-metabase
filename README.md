<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Metabase Dashboards, Questions, Lineage and Usage in DuckDB

> **vgi-metabase** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-metabase/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-metabase/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Metabase metadata and usage as SQL, read-only, through the
[Metabase REST API](https://www.metabase.com/docs/latest/api). Works with Metabase OSS
(self-hosted), Pro / Enterprise and Metabase Cloud: inventory collections, dashboards and
saved questions / models / metrics; read the SQL or MBQL behind every card; trace MBQL
questions back to warehouse tables; audit databases, users, groups and data permissions;
review subscriptions and alerts; and measure usage — per day from
[Usage Analytics](https://www.metabase.com/docs/latest/usage-and-performance-tools/usage-analytics)
on Pro / Enterprise, from lifetime view counters on OSS.

```sql
CREATE SECRET metabase (TYPE metabase,
    BASE_URL 'https://bi.acme.com',
    API_KEY 'mb_…');

-- Dashboards nobody opened in 90 days, with their collection.
SELECT title, folder_path, owner, last_viewed_at
FROM metabase.main.dashboards
WHERE NOT archived AND last_viewed_at < now() - INTERVAL 90 DAY
ORDER BY last_viewed_at;

-- Which warehouse tables feed which dashboards (MBQL questions).
SELECT DISTINCT d.dashboard_title, t.table_schema, t.table_name
FROM metabase.main.dashboard_cards d
JOIN metabase.main.card_tables t ON t.card_id = d.card_id
ORDER BY ALL;

-- Native SQL questions that mention a table you are about to drop.
SELECT id, title, native_sql FROM metabase.main.queries
WHERE query_type = 'native' AND native_sql ILIKE '%legacy_orders%';

-- Run a saved question with a filter value; columns come back typed.
SELECT * FROM metabase.main.run_card('41', parameters := '{"category": "Gizmo"}');
```

## Tables and functions

All objects live in `metabase.main` and need a `metabase` secret.

| Object | What it returns | Pushdown |
|---|---|---|
| `folders` | Collections (the folder tree) with full paths, personal owners, archive state, official / analytics type | `archived` |
| `dashboards` | Dashboards: collection path, creator, view count, last view, filter parameters | `archived` |
| `dashboard_cards` | Cards placed on dashboards: tab, grid position, text cards, filter wiring | `dashboard_id` |
| `dashboard_tabs` | Dashboard tabs with card counts | `dashboard_id` |
| `charts` | Saved questions, models and metrics (cards): type, display, native vs MBQL, database, source table / card | `id`, `table_id`, `database_id`, `archived` |
| `queries` | The query of each card: native SQL text, template tags, MBQL JSON, source tables and cards | as `charts` (`card_id` too) |
| `card_tables` | Lineage: every table / card each MBQL card reads (main source and joins, every stage), with schema and table names | as `charts` |
| `connections` | Connected databases: engine, host, port, database name — never passwords, keys, tunnels or JDBC options | `id` |
| `tables` | Synced tables: schema, display name, entity type, visibility, estimated rows | `id` |
| `fields` | Columns: base / effective / semantic types, primary and foreign keys (resolved to table and field) | `table_id`, `database_id` |
| `segments` | Segments (saved filters) with their definition | — |
| `users` | Users and their group ids — never credentials, login or JWT attributes | `id`, `is_active` |
| `groups` | Permission groups with member counts | — |
| `group_permissions` | Data permissions per group and database: view data, create queries, download, data model | — |
| `subscriptions` | Dashboard subscriptions: schedules per channel; recipients reduced to counts and email domains | `dashboard_id`, `archived` |
| `alerts` | Question alerts: condition, cron schedules; recipients reduced to counts and email domains | — |
| `revisions` | Revision history of dashboards, cards and segments | `entity_type`, `entity_id` |
| `instance` | Version, edition (OSS / enterprise), Cloud, whether Usage Analytics is available | — |
| `content_usage` | Views per dashboard / card: per day (Usage Analytics) or lifetime counters (OSS) | `view_date` range, `content_type`, `content_id` |
| `query_history` | Every query run: runtime, rows, source, error, cache hit (Usage Analytics only) | `created_at` range, `card_id`, `dashboard_id`, `user_id`, `database_id`, `source` |
| `recent_views` | What the secret's identity viewed recently | — |
| `run_card(card_id, parameters := '{…}')` | A saved question / model / metric's rows, typed from its result metadata | — |

Per-dashboard and per-object tables (`dashboard_cards`, `dashboard_tabs`, `fields`,
`revisions`) make one API call per parent, so filter on `dashboard_id`, `table_id`,
`database_id` or `entity_type` / `entity_id` when you can.

### Shared BI columns (UNION across Looker, Tableau and Metabase)

The content tables use the column names the sibling BI workers
([`vgi-looker`](https://github.com/Query-farm/vgi-looker), `vgi-tableau`) use, so
inventories UNION cleanly:

| Column | Type | Meaning in Metabase |
|---|---|---|
| `tool` | `VARCHAR` | Always `'metabase'` |
| `id` | `VARCHAR` | Metabase id |
| `title` | `VARCHAR` | Dashboard / card / collection / database name |
| `folder_path` | `VARCHAR` | `/Marketing/EMEA` — the collection chain from the root ("Our analytics" is `/`) |
| `owner` | `VARCHAR` | Display name of the creator (`owner_id` holds the id); personal-collection owner for folders |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | Creation / last update time |
| `last_viewed_at` | `TIMESTAMPTZ` | Dashboards: last view. Cards: Metabase's `last_used_at` (last run) — it keeps no separate last-view time for cards |
| `view_count` | `BIGINT` | Lifetime views Metabase counts |
| `url` | `VARCHAR` | Link into the Metabase UI (`/dashboard/2`, `/question/41`, `/model/42`, `/metric/43`) |

| Table | Shared columns present |
|---|---|
| `dashboards`, `charts` | all of them |
| `folders` | `tool, id, title, folder_path, owner, created_at, url` |
| `queries` | `tool, id, url` |
| `users` | `tool, id, url` (+ `display_name`, `email`) |
| `connections` | `tool, id, title, created_at, updated_at, url` |
| `content_usage` | `tool, url` (+ `content_type, content_id, title, view_date, view_count`) |

```sql
SELECT tool, id, title, folder_path, owner, view_count, url FROM looker.main.dashboards
UNION ALL BY NAME
SELECT tool, id, title, folder_path, owner, view_count, url FROM metabase.main.dashboards;
```

### Usage: OSS vs Pro / Enterprise

`SELECT edition, usage_analytics FROM metabase.main.instance` tells you which applies.

- **Pro / Enterprise with Usage Analytics** (the `audit_app` token feature): the worker
  finds the "View log" and "Query log" models in the Usage Analytics collection and
  queries them with read-only ad-hoc MBQL (`POST /api/dataset`, which saves nothing).
  `content_usage` has one row per (content_type, content_id, UTC day) with `view_count`,
  `user_count` and `last_viewed_at` — Metabase does the grouping; `query_history` has one
  row per query execution. The API identity needs access to the Usage analytics collection.
- **OSS** (or without the feature): Metabase exposes only lifetime counters.
  `content_usage` returns one row per live dashboard and card with `view_count` and
  `last_viewed_at` (cards: `last_used_at`), `view_date` and `user_count` NULL and
  `usage_source = 'lifetime_counters'` — a `view_date` filter therefore returns no OSS
  rows. `query_history` raises an error explaining that OSS has no query log.
  `recent_views` (the identity's own recent items) works on every edition.

### `run_card` result types

Columns keep Metabase's names (`CATEGORY`, `sum`, `count`; repeats get `_2`) and take
their type from the card's `result_metadata`: `type/Integer` / `BigInteger` `BIGINT`,
`Float` / `Decimal` `DOUBLE`, `Boolean` `BOOLEAN`, `Date` `DATE`, `DateTime` `TIMESTAMP`,
zoned date-times `TIMESTAMPTZ`, `JSON` / `Dictionary` / `Array` `JSON`, everything else
`VARCHAR`. A card that has never run has no metadata; the bind then runs it once to learn
its columns. `parameters` is a JSON object keyed by a card parameter's slug or a native
question's `{{variable}}` name; omit it to use the defaults. Metabase returns at most
2,000 rows per API query. Running a card counts as a view of that card.

## Authentication

Create an [API key](https://www.metabase.com/docs/latest/people-and-groups/api-keys)
(Admin settings > Authentication > API keys, Metabase 0.49+) in a group that can see the
content you want — the Administrators group sees everything, including users, permissions
and connections. Or use a username and password.

```sql
CREATE SECRET metabase (TYPE metabase,
    BASE_URL 'https://acme.metabaseapp.com',   -- Metabase Cloud, or your own host (+ path prefix)
    API_KEY 'mb_…');                           -- sent as x-api-key

CREATE SECRET metabase_login (TYPE metabase,
    BASE_URL 'https://bi.acme.com',
    USERNAME 'analyst@acme.com', PASSWORD '…', -- POST /api/session; the session is cached
    PAGE_SIZE '500');                          -- optional: users listing page size
```

A password login posts to `/api/session`, caches the session id in memory and logs in
again after a 401. Credentials and session ids never enter scan state, URLs, logs or error
messages. `http://` is accepted only for `127.0.0.1` / `localhost` (test fixtures).

## Pushdown, paging, rate limits and side effects

- `WHERE` predicates on the columns in the table above become API parameters (`f=table`,
  `f=database`, `f=archived`, `status=deactivated`, `entity=card&id=41`, single-object
  endpoints) or, for Usage Analytics, MBQL filters on the View log / Query log. DuckDB
  re-checks every predicate exactly, so pushdown only narrows what is fetched.
- The users listing pages with `limit` + `offset`; Usage Analytics queries page with MBQL
  `page` (2,000 rows); per-dashboard, per-database and per-object fan-outs keep their
  pending ids in scan state. All cursors are serializable, so scans resume across
  processes over HTTP.
- 429 responses wait for `Retry-After`; 5xx and network errors back off exponentially.
- **Read-only.** The only non-GET calls are `POST /api/session` (login),
  `POST /api/card/:id/query` (`run_card`) and `POST /api/dataset` (a SELECT over the Usage
  Analytics models). Nothing is created, updated or deleted. Two reads have side effects
  inside Metabase itself: `GET /api/dashboard/:id` — used by `dashboard_cards` and
  `dashboard_tabs`, there is no other endpoint for dashboard layout — counts as a view of
  that dashboard, and `run_card` counts as a view / run of the card. Use a dedicated API
  key so those views are attributable. `dashboards` never calls the per-dashboard
  endpoint (its `id` filter is applied locally).

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone https://github.com/Query-farm/vgi-metabase.git && cd vgi-metabase
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'metabase' (TYPE vgi, LOCATION '/abs/path/to/vgi-metabase/bin/vgi-metabase-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'metabase' (TYPE vgi, LOCATION '/abs/path/to/vgi-metabase/bin/vgi-metabase-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed) for Linux, macOS (arm64) and Windows; point
`LOCATION` at the downloaded binary. The same binary serves HTTP with `--http --port 8000`
(see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (MBQL parsing, masking, typing, parameters, login/retry)
make test-sql                  # test/sql/metabase.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a live Metabase. `test/mock_api/server.py` is a stdlib-only
**record / replay server**. `test/fixtures/metabase-recording.json` holds responses recorded
from a real `metabase/metabase:v0.65.4.4` (OSS) container that
`test/fixtures/seed_metabase.py` set up through the API (setup token → admin, users and a
deactivated user, a group, a collection tree, MBQL and native SQL questions with a template
tag, a model, an archived metric, a segment, a two-tab dashboard with a filter and a text
card, a subscription and an alert with an external recipient, an API key, revisions and
views). Replay is strict: any request that was not recorded fails with HTTP 400. The server
emulates Metabase auth with test credentials (`x-api-key` and `/api/session`, with session
revocation), injects one 429 and one 503 so the retry paths always run, and logs requests
at `/__requests` so the SQL tests assert exactly what was pushed down.

Synthetic additions (not recorded, documented in the server): a second connection whose
details carry a fake password, SSH key and JDBC options (the tests prove none reach SQL),
and `--edition ee`, a Pro / Enterprise variant with a Usage Analytics collection whose
"View log" / "Query log" models answer the worker's MBQL (filters, day breakouts, count /
distinct / max, order, page) from hand-built logs. The Pro / Enterprise path is therefore
tested against documented model columns, not a licensed instance.

To re-record (needs Docker, ~1.5 GB RAM):

```bash
docker run -d --name vgi-metabase-server --memory 2500m -e JAVA_OPTS="-Xmx1g" \
    -p 127.0.0.1:3917:3000 metabase/metabase:v0.65.4.4
python3 test/fixtures/seed_metabase.py http://127.0.0.1:3917 > /tmp/seed.json
python3 test/fixtures/record.py http://127.0.0.1:3917 /tmp/seed.json
docker rm -f vgi-metabase-server
```

The metadata check runs with `execute: false` in CI: every object needs a `metabase`
secret for a live site.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
