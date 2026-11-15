#!/usr/bin/env python3
"""Seed a throwaway Metabase OSS container with the content the SQL tests expect.

Used once to (re)record ``test/fixtures/metabase-recording.json``; CI never runs it.

    docker run -d --name vgi-metabase-server --memory 2500m \
        -e JAVA_OPTS="-Xmx1g -XX:+UseSerialGC" -e MB_ANON_TRACKING_ENABLED=false \
        -p 127.0.0.1:3917:3000 metabase/metabase:v0.65.4.4
    python3 test/fixtures/seed_metabase.py http://127.0.0.1:3917 > seed.json

It completes the setup wizard (setup token -> admin user), then builds: a few
users (one deactivated) and a group, a collection tree, MBQL questions, a native SQL
question with a template tag, a model, a metric, a segment, a dashboard with two tabs,
a filter parameter and text + question cards, a dashboard subscription and an alert
(with an external email recipient), an API key, some revisions and views. It prints
the ids and the admin / API-key credentials (local container only) as JSON on stdout.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3917").rstrip("/")
ADMIN = {"email": "ada@example.com", "password": "Seed-Password-1!", "first_name": "Ada", "last_name": "Lovelace"}
SESSION: dict[str, str] = {}


def call(method: str, path: str, body: object = None, session: str | None = None) -> object:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    tok = session or SESSION.get("id")
    if tok:
        req.add_header("X-Metabase-Session", tok)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            text = res.read().decode()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:800]}") from None
    return json.loads(text) if text.strip() else None


def login(email: str, password: str) -> str:
    return call("POST", "/api/session", {"username": email, "password": password})["id"]  # type: ignore[index]


def main() -> None:
    props = call("GET", "/api/session/properties")
    if not props.get("has-user-setup"):  # type: ignore[union-attr]
        res = call("POST", "/api/setup", {
            "token": props["setup-token"],  # type: ignore[index]
            "user": {**ADMIN, "site_name": "Acme Analytics"},
            "prefs": {"site_name": "Acme Analytics", "site_locale": "en", "allow_tracking": False},
        })
        SESSION["id"] = res["id"]  # type: ignore[index]
    else:
        SESSION["id"] = login(ADMIN["email"], ADMIN["password"])

    dbs = call("GET", "/api/database")
    dbs = dbs["data"] if isinstance(dbs, dict) else dbs
    sample = next((d for d in dbs if d.get("is_sample")), None)
    if sample is None:
        sample = call("POST", "/api/database/sample_database")
    db_id = sample["id"]
    # Wait for the sample database sync so table / field ids exist.
    for _ in range(120):
        meta = call("GET", f"/api/database/{db_id}/metadata")
        tables = {t["name"]: t for t in meta["tables"]}  # type: ignore[index]
        if {"ORDERS", "PRODUCTS", "PEOPLE"} <= tables.keys() and all(t.get("fields") for t in tables.values()):
            break
        time.sleep(2)
    else:
        raise SystemExit("sample database never synced")
    orders, products, people = tables["ORDERS"], tables["PRODUCTS"], tables["PEOPLE"]

    def fid(table: dict, name: str) -> int:
        return next(f["id"] for f in table["fields"] if f["name"] == name)

    # Users and a group.
    users = {}
    for first, last, email in [("Grace", "Hopper", "grace@example.com"), ("Alan", "Turing", "alan@partner.org"),
                               ("Old", "Account", "old@example.com")]:
        u = call("POST", "/api/user", {"first_name": first, "last_name": last, "email": email,
                                         "password": "Seed-Password-2!"})
        users[first] = u["id"]  # type: ignore[index]
    call("DELETE", f"/api/user/{users['Old']}")  # deactivate
    analysts = call("POST", "/api/permissions/group", {"name": "Analysts"})
    call("POST", "/api/permissions/membership", {"group_id": analysts["id"], "user_id": users["Grace"]})  # type: ignore[index]
    call("POST", "/api/permissions/membership", {"group_id": analysts["id"], "user_id": users["Alan"]})  # type: ignore[index]

    # Collections: Marketing / EMEA, Finance (archived later), plus root content.
    marketing = call("POST", "/api/collection", {"name": "Marketing", "description": "Marketing team content"})
    emea = call("POST", "/api/collection", {"name": "EMEA", "parent_id": marketing["id"]})  # type: ignore[index]
    finance = call("POST", "/api/collection", {"name": "Finance"})

    def mbql(query: dict) -> dict:
        return {"type": "query", "database": db_id, "query": query}

    def card(name: str, dataset_query: dict, display: str, coll: dict | None, ctype: str = "question",
             description: str | None = None) -> dict:
        return call("POST", "/api/card", {
            "name": name, "type": ctype, "dataset_query": dataset_query, "display": display,
            "visualization_settings": {}, "collection_id": coll["id"] if coll else None,
            "description": description,
        })  # type: ignore[return-value]

    revenue = card("Revenue by Category", mbql({
        "source-table": orders["id"],
        "joins": [{"source-table": products["id"], "alias": "Products", "fields": "none",
                   "condition": ["=", ["field", fid(orders, "PRODUCT_ID"), None],
                                 ["field", fid(products, "ID"), {"join-alias": "Products"}]]}],
        "aggregation": [["sum", ["field", fid(orders, "TOTAL"), None]]],
        "breakout": [["field", fid(products, "CATEGORY"), {"join-alias": "Products"}]],
    }), "bar", marketing, description="Total order revenue per product category")
    native = card("Orders by Category (SQL)", {
        "type": "native", "database": db_id,
        "native": {
            "query": "SELECT p.CATEGORY, count(*) AS ORDERS, sum(o.TOTAL) AS REVENUE, max(o.CREATED_AT) AS LAST_ORDER\n"
                     "FROM ORDERS o JOIN PRODUCTS p ON p.ID = o.PRODUCT_ID\n"
                     "WHERE p.CATEGORY = {{category}}\nGROUP BY p.CATEGORY",
            "template-tags": {"category": {"id": "c0ffee00-0000-4000-8000-000000000001", "name": "category",
                                            "display-name": "Category", "type": "text", "default": "Widget"}},
        },
    }, "table", emea)
    model = card("Orders Model", mbql({"source-table": orders["id"]}), "table", marketing, ctype="model",
                 description="Every order, one row per order")
    metric = card("Order Count", mbql({"source-table": orders["id"], "aggregation": [["count"]]}), "scalar",
                  finance, ctype="metric")
    people_q = card("People by Source", mbql({
        "source-table": people["id"], "aggregation": [["count"]],
        "breakout": [["field", fid(people, "SOURCE"), None]],
    }), "pie", None)
    from_model = card("Large Orders from Model", mbql({
        "source-table": f"card__{model['id']}",
        "filter": [">", ["field", "TOTAL", {"base-type": "type/Float"}], 100],
        "limit": 50,
    }), "table", emea)

    # Segment on ORDERS.
    segment = call("POST", "/api/segment", {
        "name": "Big Orders", "description": "Orders over 100", "table_id": orders["id"],
        "definition": mbql({"source-table": orders["id"], "filter": [">", ["field", fid(orders, "TOTAL"), None], 100]}),
    })

    # Dashboard: two tabs, a category filter, three cards and a text card.
    dash = call("POST", "/api/dashboard", {"name": "Sales Overview", "collection_id": marketing["id"],  # type: ignore[index]
                                           "description": "Revenue and orders at a glance"})
    param = {"id": "f1a2b3c4", "name": "Category", "slug": "category", "type": "string/=",
             "sectionId": "string", "default": ["Widget"]}
    call("PUT", f"/api/dashboard/{dash['id']}", {  # type: ignore[index]
        "parameters": [param],
        "tabs": [{"id": -1, "name": "Overview"}, {"id": -2, "name": "Details"}],
        "dashcards": [
            {"id": -1, "card_id": revenue["id"], "dashboard_tab_id": -1, "row": 0, "col": 0, "size_x": 12,
             "size_y": 6, "parameter_mappings": [{"parameter_id": "f1a2b3c4", "card_id": revenue["id"],
                                                    "target": ["dimension", ["field", fid(products, "CATEGORY"),
                                                                             {"join-alias": "Products"}]]}],
             "visualization_settings": {}},
            {"id": -2, "card_id": native["id"], "dashboard_tab_id": -1, "row": 0, "col": 12, "size_x": 12,
             "size_y": 6, "parameter_mappings": [{"parameter_id": "f1a2b3c4", "card_id": native["id"],
                                                    "target": ["variable", ["template-tag", "category"]]}],
             "visualization_settings": {}},
            {"id": -3, "card_id": None, "dashboard_tab_id": -2, "row": 0, "col": 0, "size_x": 24, "size_y": 2,
             "parameter_mappings": [], "visualization_settings": {
                 "virtual_card": {"name": None, "display": "text", "visualization_settings": {},
                                  "dataset_query": {}, "archived": False},
                 "text": "## Details\nOrder-level numbers."}},
            {"id": -4, "card_id": people_q["id"], "dashboard_tab_id": -2, "row": 2, "col": 0, "size_x": 12,
             "size_y": 6, "parameter_mappings": [], "visualization_settings": {}},
        ],
    })
    dash2 = call("POST", "/api/dashboard", {"name": "Finance Archive", "collection_id": finance["id"]})
    call("PUT", f"/api/dashboard/{dash2['id']}", {"archived": True})  # type: ignore[index]
    dash_full = call("GET", f"/api/dashboard/{dash['id']}")  # type: ignore[index]
    dashcard_ids = {dc["card_id"]: dc["id"] for dc in dash_full["dashcards"]}  # type: ignore[index]

    # Archive the metric so archived cards are covered.
    call("PUT", f"/api/card/{metric['id']}", {"archived": True})

    # Revisions: rename the SQL question and edit the dashboard description.
    call("PUT", f"/api/card/{native['id']}", {"description": "Orders and revenue for one category"})
    call("PUT", f"/api/dashboard/{dash['id']}", {"description": "Revenue, orders and people at a glance"})  # type: ignore[index]

    # Subscription + alert. Email must look configured; the SMTP host is never contacted
    # because no schedule fires during the recording.
    for k, v in {"email-smtp-host": "smtp.invalid", "email-smtp-port": 25, "email-from-address": "bi@example.com",
                 "email-smtp-security": "none"}.items():
        try:
            call("PUT", f"/api/setting/{k}", {"value": v})
        except SystemExit as e:
            print(f"warning: {e}", file=sys.stderr)
    notes = {}
    try:
        notes["pulse"] = call("POST", "/api/pulse", {
            "name": "Sales Overview", "dashboard_id": dash["id"], "collection_id": marketing["id"],  # type: ignore[index]
            "cards": [{"id": revenue["id"], "include_csv": True, "include_xls": False,
                       "dashboard_card_id": dashcard_ids[revenue["id"]]}],
            "channels": [{"channel_type": "email", "enabled": True, "schedule_type": "weekly",
                          "schedule_day": "mon", "schedule_hour": 8, "schedule_frame": None,
                          "recipients": [{"id": users["Grace"]}, {"email": "cfo@partner.org"}]}],
            "skip_if_empty": False,
        })
    except SystemExit as e:
        print(f"warning: pulse: {e}", file=sys.stderr)
    try:
        notes["alert"] = call("POST", "/api/notification", {
            "payload_type": "notification/card",
            "payload": {"card_id": revenue["id"], "send_condition": "has_result", "send_once": False},
            "handlers": [{"channel_type": "channel/email", "recipients": [
                {"type": "notification-recipient/user", "user_id": users["Grace"]},
                {"type": "notification-recipient/raw-value", "details": {"value": "ops@partner.org"}}]}],
            "subscriptions": [{"type": "notification-subscription/cron", "cron_schedule": "0 0 9 * * ? *"}],
        })
    except SystemExit as e:
        print(f"warning: alert: {e}", file=sys.stderr)

    # API key in the Administrators group (id 2).
    key = call("POST", "/api/api-key", {"name": "vgi-metabase recording", "group_id": 2})

    # Views: open the dashboard and run cards as two users.
    grace = login("grace@example.com", "Seed-Password-2!")
    for tok in (SESSION["id"], grace):
        call("GET", f"/api/dashboard/{dash['id']}", session=tok)  # type: ignore[index]
        call("POST", f"/api/card/{revenue['id']}/query", {}, session=tok)
        call("GET", f"/api/card/{revenue['id']}", session=tok)
    call("POST", f"/api/card/{native['id']}/query", {}, session=SESSION["id"])
    call("POST", f"/api/collection", {"name": "Scratch"})  # an empty collection

    print(json.dumps({
        "version": props["version"], "database_id": db_id,  # type: ignore[index]
        "tables": {"ORDERS": orders["id"], "PRODUCTS": products["id"], "PEOPLE": people["id"]},
        "users": users, "group": analysts["id"],  # type: ignore[index]
        "collections": {"Marketing": marketing["id"], "EMEA": emea["id"], "Finance": finance["id"]},  # type: ignore[index]
        "cards": {"revenue": revenue["id"], "native": native["id"], "model": model["id"], "metric": metric["id"],
                  "people": people_q["id"], "from_model": from_model["id"]},
        "segment": segment["id"], "dashboards": [dash["id"], dash2["id"]],  # type: ignore[index]
        "notes": {k: v.get("id") for k, v in notes.items() if isinstance(v, dict)},
        "admin": ADMIN, "api_key": key.get("unmasked_key"),  # type: ignore[union-attr]
    }, indent=2))


if __name__ == "__main__":
    main()
