/**
 * Small per-process lookups that enrich rows: collection paths, user names, table
 * and database names, and the instance's edition.
 *
 * Each is one API call, cached in process memory for a minute per Metabase site +
 * identity. They never enter scan state; a process serving a resumed scan loads them
 * again.
 */

import { cacheKey, type MetabaseConfig, metabaseRequest } from "./client.ts";
import { asStr, defaultRows, type Row } from "./table.ts";

const TTL_MS = 60_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}
const caches = new Map<string, Map<string, Cached<unknown>>>();

/** Forget cached lookups (tests). */
export function clearLookupCache(): void {
  caches.clear();
}

function cached<T>(name: string, cfg: MetabaseConfig, load: () => Promise<T>): Promise<T> {
  let cache = caches.get(name);
  if (!cache) {
    cache = new Map();
    caches.set(name, cache);
  }
  const key = cacheKey(cfg);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

export interface CollectionInfo {
  name: string;
  path: string;
}

/**
 * Build `/Marketing/EMEA`-style paths from collections. Metabase gives each collection
 * a `location` of ancestor ids (`/8/`); the root collection ("Our analytics") is `/`.
 */
export function buildCollectionPaths(
  cols: { id: string; name: string; location: string | null }[],
): Map<string, CollectionInfo> {
  const names = new Map(cols.map((c) => [c.id, c.name]));
  const out = new Map<string, CollectionInfo>();
  for (const c of cols) {
    const ancestors = (c.location ?? "/").split("/").filter(Boolean);
    const parts = [...ancestors.map((a) => names.get(a) ?? `#${a}`), c.name];
    out.set(c.id, { name: c.name, path: `/${parts.join("/")}` });
  }
  return out;
}

/** collection id → name and path, for every collection (archived included) the identity can see. */
export function collections(cfg: MetabaseConfig): Promise<Map<string, CollectionInfo>> {
  return cached("collections", cfg, async () => {
    const [live, archived] = await Promise.all([
      metabaseRequest(cfg, "/collection"),
      metabaseRequest(cfg, "/collection", { query: { archived: true } }),
    ]);
    const rows = [...defaultRows(live), ...defaultRows(archived)].filter((r) => typeof r.id === "number");
    return buildCollectionPaths(
      rows.map((r) => ({ id: String(r.id), name: asStr(r.name) ?? "", location: asStr(r.location) })),
    );
  });
}

/** The folder path of a collection id (`null` id = the root collection, `/`). */
export function collectionPath(paths: Map<string, CollectionInfo>, id: unknown): string | null {
  if (id === null || id === undefined || id === "root") return "/";
  return paths.get(String(id))?.path ?? null;
}

/** user id → display name, for owner columns (deactivated users included). */
export function userNames(cfg: MetabaseConfig): Promise<Map<string, string>> {
  return cached("users", cfg, async () => {
    const out = new Map<string, string>();
    for (let offset = 0, guard = 0; guard < 10_000; guard++) {
      const body = await metabaseRequest(cfg, "/user", { query: { status: "all", limit: cfg.pageSize, offset } });
      const page = defaultRows(body);
      for (const r of page) {
        const name = asStr(r.common_name) ?? ([r.first_name, r.last_name].filter(Boolean).join(" ") || asStr(r.email));
        if (r.id != null && name) out.set(String(r.id), name);
      }
      if (page.length < cfg.pageSize) break;
      offset += page.length;
    }
    return out;
  });
}

export interface TableInfo {
  dbId: string | null;
  schema: string | null;
  name: string | null;
  displayName: string | null;
}

/** table id → database / schema / name, for lineage. */
export function tableInfo(cfg: MetabaseConfig): Promise<Map<string, TableInfo>> {
  return cached("tables", cfg, async () => {
    const rows = defaultRows(await metabaseRequest(cfg, "/table"));
    return new Map(
      rows.map((r) => [
        String(r.id),
        {
          dbId: r.db_id != null ? String(r.db_id) : null,
          schema: asStr(r.schema),
          name: asStr(r.name),
          displayName: asStr(r.display_name),
        },
      ]),
    );
  });
}

/** database id → name. */
export function databaseNames(cfg: MetabaseConfig): Promise<Map<string, string>> {
  return cached("databases", cfg, async () => {
    const rows = defaultRows(await metabaseRequest(cfg, "/database"));
    return new Map(rows.map((r) => [String(r.id), asStr(r.name) ?? ""]));
  });
}

export interface Edition {
  version: string | null;
  /** 'oss' | 'enterprise' (Pro / Enterprise build) */
  edition: "oss" | "enterprise";
  isHosted: boolean;
  /** Usage Analytics (the `audit_app` token feature) is licensed and enabled. */
  usageAnalytics: boolean;
  properties: Row;
}

/** Classify an instance from `/api/session/properties`. */
export function editionOf(props: Row): Edition {
  const tag = asStr(props.version?.tag) ?? null;
  const features: Row = props["token-features"] ?? {};
  // Enterprise / Pro builds are versioned v1.x; OSS builds v0.x.
  const enterpriseBuild = !!tag && /^v1\./.test(tag);
  const anyFeature = Object.values(features).some((v) => v === true);
  return {
    version: tag,
    edition: enterpriseBuild || anyFeature ? "enterprise" : "oss",
    isHosted: props["is-hosted?"] === true || features.hosting === true,
    usageAnalytics: features.audit_app === true,
    properties: props,
  };
}

export function edition(cfg: MetabaseConfig): Promise<Edition> {
  return cached("edition", cfg, async () => editionOf((await metabaseRequest(cfg, "/session/properties")) as Row));
}

/** Attach `__folder_path` and `__owner` to rows. */
export async function withFolderAndOwner(
  cfg: MetabaseConfig,
  rows: Row[],
  folderOf: ((r: Row) => unknown) | null,
  ownerOf: ((r: Row) => unknown) | null,
): Promise<Row[]> {
  const needNames = ownerOf && rows.some((r) => r.__owner === undefined && ownerOf(r) != null);
  const [paths, names] = await Promise.all([
    folderOf ? collections(cfg) : Promise.resolve(null),
    needNames ? userNames(cfg) : Promise.resolve(null),
  ]);
  return rows.map((r) => {
    const uid = ownerOf ? ownerOf(r) : null;
    return {
      ...r,
      __folder_path: folderOf && paths ? collectionPath(paths, folderOf(r)) : null,
      __owner: r.__owner ?? (uid != null && names ? (names.get(String(uid)) ?? null) : null),
    };
  });
}

/**
 * Summarise recipients without exposing them: how many there are, how many are
 * Metabase users vs external addresses vs groups, and the distinct email domains
 * (never the addresses, Slack channels or webhook URLs).
 */
export function maskRecipients(emails: (string | null)[], users: number, groups: number, external: number) {
  const domains = new Set<string>();
  for (const a of emails) {
    const m = a?.match(/@([A-Za-z0-9.-]+)\s*$/);
    if (m?.[1]) domains.add(m[1].toLowerCase());
  }
  return {
    recipient_count: users + groups + external,
    user_recipient_count: users,
    group_recipient_count: groups,
    external_recipient_count: external,
    recipient_domains: [...domains].sort(),
  };
}

/**
 * The safe parts of a database connection's `details`: host, port and database name.
 * Never passwords, keys, tunnels' secrets, JDBC options or service-account JSON.
 */
export function safeDetails(details: unknown): { host: string | null; port: number | null; dbName: string | null } {
  const d = (details && typeof details === "object" ? details : {}) as Row;
  const host = asStr(d.host);
  const port = typeof d.port === "number" ? d.port : /^\d+$/.test(String(d.port ?? "")) ? Number(d.port) : null;
  let dbName = asStr(d.dbname) ?? asStr(d.db) ?? asStr(d.catalog) ?? asStr(d["project-id"]) ?? asStr(d["service-name"]);
  if (dbName) {
    // H2 / JDBC style `file:/path;USER=x;PASSWORD=y` and `scheme://user:pass@host/db`: keep only the target.
    dbName = dbName.split(";")[0]?.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1") ?? null;
    dbName = dbName?.replace(/[?&](password|pwd|user|token|key)=[^&]*/gi, "") ?? null;
  }
  return { host: host ? host.replace(/^[^/@\s]*@/, "") : null, port, dbName };
}
