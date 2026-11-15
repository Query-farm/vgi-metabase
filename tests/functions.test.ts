// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  clearSessionCache,
  configFromSecrets,
  type MetabaseConfig,
  metabaseRequest,
  normalizeBaseUrl,
  retryAfterMs,
} from "../src/metabase/client.ts";
import { buildCollectionPaths, editionOf, maskRecipients, safeDetails } from "../src/metabase/lookups.ts";
import { nativeQuery, querySources, queryType, templateTags } from "../src/metabase/mbql.ts";
import { type Constraint, timeBounds } from "../src/metabase/pushdown.ts";
import { buildParameters, columnsOf, convert, dedupe, kindOfType } from "../src/metabase/run.ts";
import { asTime } from "../src/metabase/table.ts";
import { datasetRows, scanWindow } from "../src/metabase/usage.ts";

const ROOT = join(import.meta.dir, "..");
const DAY = 86_400_000;

test("base_url: https required except loopback; a trailing /api and slashes are dropped", () => {
  expect(normalizeBaseUrl("https://acme.metabaseapp.com/")).toBe("https://acme.metabaseapp.com");
  expect(normalizeBaseUrl("https://bi.acme.com/metabase/api/")).toBe("https://bi.acme.com/metabase");
  expect(normalizeBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  expect(() => normalizeBaseUrl("http://bi.acme.com")).toThrow(/https/);
  expect(() => normalizeBaseUrl("https://u:p@bi.acme.com")).toThrow(/credentials/);
  expect(() => normalizeBaseUrl("nope")).toThrow(/not a URL/);
});

test("configFromSecrets: an API key, or a username + password; page_size validated", () => {
  expect(() => configFromSecrets({})).toThrow(/no metabase secret/);
  const base = { type: "metabase", base_url: "https://bi.acme.com" };
  expect(() => configFromSecrets({ s: base })).toThrow(/api_key, or username and password/);
  expect(() => configFromSecrets({ s: { ...base, username: "a@b.c" } })).toThrow(/api_key, or username/);
  const k = configFromSecrets({ s: { ...base, api_key: "mb_x", username: "u", password: "p" } });
  expect(k.apiKey).toBe("mb_x");
  expect(k.username).toBeUndefined(); // the API key wins
  expect(configFromSecrets({ s: { ...base, username: "u", password: "p" } }).pageSize).toBe(500);
  expect(configFromSecrets({ s: { ...base, api_key: "k", page_size: "25" } }).pageSize).toBe(25);
  expect(() => configFromSecrets({ s: { ...base, api_key: "k", page_size: "0" } })).toThrow(/page_size/);
});

test("retryAfterMs: seconds or HTTP date, bounded", () => {
  expect(retryAfterMs(new Headers({ "Retry-After": "2" }))).toBe(2000);
  expect(retryAfterMs(new Headers({ "Retry-After": "9999" }))).toBe(60_000);
  const now = Date.parse("2026-11-15T00:00:00Z");
  expect(retryAfterMs(new Headers({ "Retry-After": "Sun, 15 Nov 2026 00:00:05 GMT" }), now)).toBe(5000);
  expect(retryAfterMs(new Headers())).toBeUndefined();
});

test("collection paths from location ancestry; root is /", () => {
  const paths = buildCollectionPaths([
    { id: "8", name: "Marketing", location: "/" },
    { id: "9", name: "EMEA", location: "/8/" },
    { id: "12", name: "Q4", location: "/8/9/" },
    { id: "13", name: "Orphan", location: "/77/" },
  ]);
  expect(paths.get("12")?.path).toBe("/Marketing/EMEA/Q4");
  expect(paths.get("13")?.path).toBe("/#77/Orphan");
});

test("connection details: only host, port and database name survive", () => {
  expect(
    safeDetails({
      host: "db.acme.com",
      port: "5432",
      dbname: "dw",
      user: "u",
      password: "SECRET",
      "tunnel-private-key": "K",
    }),
  ).toEqual({ host: "db.acme.com", port: 5432, dbName: "dw" });
  expect(safeDetails({ db: "file:/data/app.db;USER=GUEST;PASSWORD=guest" }).dbName).toBe("file:/data/app.db");
  expect(safeDetails({ db: "postgres://u:pw@h/db?password=x&sslmode=require" }).dbName).toBe(
    "postgres://h/db&sslmode=require",
  );
  expect(safeDetails(null)).toEqual({ host: null, port: null, dbName: null });
});

test("recipients are summarised: counts and domains only", () => {
  expect(maskRecipients(["a@Example.com", "b@partner.org", null, "c@example.com"], 2, 1, 1)).toEqual({
    recipient_count: 4,
    user_recipient_count: 2,
    group_recipient_count: 1,
    external_recipient_count: 1,
    recipient_domains: ["example.com", "partner.org"],
  });
});

test("edition: OSS v0.x, Pro/Enterprise v1.x or any token feature; Usage Analytics = audit_app", () => {
  expect(editionOf({ version: { tag: "v0.65.4" }, "token-features": { audit_app: false } })).toMatchObject({
    edition: "oss",
    usageAnalytics: false,
  });
  expect(editionOf({ version: { tag: "v1.65.4" }, "token-features": { audit_app: true } })).toMatchObject({
    edition: "enterprise",
    usageAnalytics: true,
  });
  expect(editionOf({ version: { tag: "v1.50.0" }, "is-hosted?": true }).isHosted).toBe(true);
});

test("MBQL: legacy and pMBQL sources, joins, nested source-query and card sources", () => {
  const legacy = {
    type: "query",
    database: 1,
    query: {
      "source-query": { "source-table": 2 },
      joins: [
        { "source-table": "card__42", alias: "M" },
        { "source-table": 3, alias: "P" },
      ],
    },
  };
  expect(querySources(legacy).map((s) => [s.role, s.tableId, s.cardId, s.joinAlias])).toEqual([
    ["source", 2, null, null],
    ["join", null, 42, "M"],
    ["join", 3, null, "P"],
  ]);
  const pmbql = {
    "lib/type": "mbql/query",
    database: 1,
    stages: [
      { "lib/type": "mbql.stage/mbql", "source-card": 42, joins: [{ alias: "P", stages: [{ "source-table": 3 }] }] },
      { "lib/type": "mbql.stage/mbql" },
    ],
  };
  expect(querySources(pmbql).map((s) => [s.role, s.tableId, s.cardId, s.joinAlias])).toEqual([
    ["source", null, 42, null],
    ["join", 3, null, "P"],
  ]);
  expect(queryType(pmbql)).toBe("query");
});

test("MBQL: native SQL and template tags in both formats", () => {
  const legacy = {
    type: "native",
    database: 1,
    native: { query: "SELECT {{x}}", "template-tags": { x: { name: "x", type: "number", "display-name": "X" } } },
  };
  const pmbql = {
    "lib/type": "mbql/query",
    stages: [{ "lib/type": "mbql.stage/native", native: "SELECT 1", "template-tags": [{ name: "y", type: "text" }] }],
  };
  expect([queryType(legacy), nativeQuery(legacy), templateTags(legacy)[0]?.displayName]).toEqual([
    "native",
    "SELECT {{x}}",
    "X",
  ]);
  expect([queryType(pmbql), nativeQuery(pmbql), templateTags(pmbql)[0]?.name]).toEqual(["native", "SELECT 1", "y"]);
  expect(querySources(pmbql)).toEqual([]);
});

test("run_card: Metabase types → DuckDB kinds and value conversion", () => {
  expect(kindOfType("type/BigInteger")).toBe("bigint");
  expect(kindOfType("type/Decimal")).toBe("double");
  expect(kindOfType("type/DateTimeWithLocalTZ")).toBe("timestamptz");
  expect(kindOfType("type/DateTime")).toBe("timestamp");
  expect(kindOfType("type/JSON")).toBe("json");
  expect(kindOfType("type/Text")).toBe("str");
  expect(convert("timestamp", "2029-04-19T14:07:15.657+02:00")).toBe(asTime("2029-04-19T14:07:15.657"));
  expect(convert("bigint", 5)).toBe(5n);
  expect(convert("json", { a: 1 })).toBe('{"a":1}');
  expect(dedupe(["sum", "sum", "count"])).toEqual(["sum", "sum_2", "count"]);
  expect(columnsOf([{ name: "n", base_type: "type/Integer", effective_type: "type/Float" }])[0]?.kind).toBe("double");
});

test("run_card parameters: card parameters by slug, native variables by name, unknown keys rejected", () => {
  const card = {
    id: 41,
    parameters: [{ id: "p1", slug: "state", type: "string/=", target: ["dimension", ["field", 9, null]] }],
    dataset_query: {
      "lib/type": "mbql/query",
      stages: [
        {
          "lib/type": "mbql.stage/native",
          native: "…",
          "template-tags": [{ name: "category", id: "t1", type: "text" }],
        },
      ],
    },
  };
  expect(buildParameters(card, '{"state": "CA", "category": "Gizmo"}')).toEqual([
    { id: "p1", type: "string/=", target: ["dimension", ["field", 9, null]], value: "CA" },
    { id: "t1", type: "category", target: ["variable", ["template-tag", "category"]], value: "Gizmo" },
  ]);
  expect(buildParameters(card, "{}")).toEqual([]);
  expect(() => buildParameters(card, '{"colour": 1}')).toThrow(/no parameter 'colour'/);
  expect(() => buildParameters(card, "not json")).toThrow(/JSON object/);
});

test("scanWindow: whole UTC days ending today for DATE columns; pushed bounds win", () => {
  const anchorMs = Date.parse("2026-11-15T13:00:00Z");
  const ctx = (constraints: Constraint[]) => ({ constraints, anchorMs, cfg: {} as MetabaseConfig });
  const [lo, hi] = scanWindow(ctx([]), "view_date", true, 30);
  expect([new Date(lo).toISOString(), new Date(hi).toISOString()]).toEqual([
    "2026-10-17T00:00:00.000Z",
    "2026-11-16T00:00:00.000Z",
  ]);
  const c: Constraint[] = [{ kind: "cmp", column: "created_at", op: "ge", value: "2026-11-01T00:00:00Z" }];
  expect(scanWindow(ctx(c), "created_at", false, 7)[0]).toBe(Date.parse("2026-11-01T00:00:00Z"));
  expect(timeBounds([{ kind: "cmp", column: "d", op: "le", value: "2026-11-01" }], "d", true).upper).toBe(
    Date.parse("2026-11-01T00:00:00Z") + DAY,
  );
});

test("datasetRows: rows keyed by column name and position", () => {
  const rows = datasetRows({ data: { cols: [{ name: "a" }, { name: "a" }], rows: [[1, 2]] } });
  expect(rows[0]).toEqual({ $0: 1, $1: 2, a: 1 });
  expect(() => datasetRows({ error: "boom" })).toThrow(/boom/);
});

// ------------------------------------------------------- client against the replay server

let server: ReturnType<typeof Bun.spawn> | undefined;
let base = "";

beforeAll(async () => {
  server = Bun.spawn(["python3", join(ROOT, "test/mock_api/server.py")], { stdout: "pipe", stderr: "ignore" });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!/PORT:\d+/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  base = `http://127.0.0.1:${text.match(/PORT:(\d+)/)?.[1]}`;
});

afterAll(() => server?.kill());

const cfgOf = (over: Partial<MetabaseConfig>): MetabaseConfig => ({ baseUrl: base, pageSize: 500, ...over });

test("client: a session login is cached and repeated after a 401", async () => {
  clearSessionCache();
  const cfg = cfgOf({ username: "ada@example.com", password: "test-password" });
  await metabaseRequest(cfg, "/permissions/graph");
  await metabaseRequest(cfg, "/permissions/graph");
  await fetch(`${base}/__expire_sessions`);
  await metabaseRequest(cfg, "/permissions/graph");
  const logins = (await (await fetch(`${base}/__requests?path=/api/session`)).json()) as unknown[];
  expect(logins.length).toBe(2);
});

test("client: honours 429 Retry-After, retries 503, reports HTTP errors with the status", async () => {
  const cfg = cfgOf({ apiKey: "mb_test_api_key" });
  const t0 = Date.now();
  const groups = (await metabaseRequest(cfg, "/permissions/group")) as unknown[];
  expect(groups.length).toBe(3);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  expect(((await metabaseRequest(cfg, "/segment")) as unknown[]).length).toBe(1);
  await expect(metabaseRequest(cfgOf({ apiKey: "nope" }), "/segment")).rejects.toThrow(/HTTP 401 \(check api_key\)/);
  await expect(metabaseRequest(cfg, "/card/404")).rejects.toThrow(/HTTP 400.*unrecorded/);
});
