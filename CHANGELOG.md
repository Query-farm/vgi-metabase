# Changelog

## 0.1.0 (unreleased)

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

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
