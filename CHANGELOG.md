# Changelog

## 0.2.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52 and @query-farm/vgi-rpc to 0.30. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.1.3 (2026-11-16)

- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.2 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

Initial release: Metabase metadata and usage as SQL (read-only).

- Content: `folders` (collections), `dashboards`, `dashboard_cards`, `dashboard_tabs`,
  `charts` (questions, models, metrics), `queries` (native SQL / MBQL, legacy and pMBQL).
- Lineage: `card_tables` (MBQL sources and joins resolved to schema.table).
- Data model: `connections` (no passwords / keys / JDBC options), `tables`, `fields`, `segments`.
- Admin: `users` (no credentials), `groups`, `group_permissions`.
- Delivery: `subscriptions`, `alerts` (recipients masked to counts and email domains).
- Usage: `instance` (edition detection), `content_usage` and `query_history` (Usage Analytics
  on Pro/Enterprise, lifetime counters on OSS), `recent_views`, `revisions`.
- `run_card(card_id, parameters := '{…}')` typed from result metadata.
- `metabase` secret: BASE_URL plus API_KEY (x-api-key) or USERNAME / PASSWORD (session).
- Fixtures recorded from a real Metabase OSS 0.65.4.4 container; strict replay server.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)
