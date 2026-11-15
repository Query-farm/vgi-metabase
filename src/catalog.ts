/**
 * Assemble the `metabase` catalog: the API collections as tables, run_card,
 * and the `metabase` secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { CATALOG_COMMENT, CATALOG_NAME, CATALOG_TAGS, SCHEMA_DOC_MD, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";
import { SECRET_TYPE } from "./metabase/client.ts";
import { RESOURCE_TABLES } from "./metabase/resources.ts";
import { RUN_FUNCTIONS } from "./metabase/run.ts";
import { USAGE_TABLES } from "./metabase/usage.ts";

export const FUNCTIONS: VgiFunction[] = RUN_FUNCTIONS;
export const TABLES = [...RESOURCE_TABLES, ...USAGE_TABLES];

const doc = (text: string) => new Map([["vgi_doc", text]]);

/** CREATE SECRET (TYPE metabase, BASE_URL '…', API_KEY '…') or (…, USERNAME '…', PASSWORD '…'). */
export const METABASE_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Metabase site URL plus an API key, or a username / password for a session login",
  schema: schema(
    [
      field(
        "base_url",
        utf8(),
        true,
        doc(
          "Metabase site URL, e.g. https://acme.metabaseapp.com or https://bi.acme.com (http:// only for 127.0.0.1/localhost).",
        ),
      ),
      field(
        "api_key",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          [
            "vgi_doc",
            "API key (Admin settings > Authentication > API keys), sent as x-api-key. Use this or username + password.",
          ],
        ]),
      ),
      field("username", utf8(), true, doc("Login email for a session login (when no api_key).")),
      field(
        "password",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          ["vgi_doc", "Password paired with username."],
        ]),
      ),
      field("page_size", utf8(), true, doc("Optional page size for the paged users listing (default 500).")),
    ],
    new Map([["vgi_doc_url", "https://www.metabase.com/docs/latest/people-and-groups/api-keys"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const ALL_EXAMPLES = [
  ...stampExampleQueries(FUNCTIONS),
  ...TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]),
];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [METABASE_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tables: TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
  ],
};
