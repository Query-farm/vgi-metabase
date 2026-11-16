#!/usr/bin/env python3
"""Record / replay server for the vgi-metabase tests (stdlib only).

Replay (the default, what CI runs) serves ``test/fixtures/metabase-recording.json``:
responses recorded from a real Metabase OSS container (see
``test/fixtures/seed_metabase.py``) keyed by method, path, sorted query string and
canonical JSON body. It is strict: a request that was not recorded gets ``400
unrecorded request`` so any change in what the worker asks for fails the tests.

Both modes emulate Metabase auth with test credentials (never the real ones):

* ``x-api-key: mb_test_api_key`` (an API key), or
* ``POST /api/session`` with ``{"username": "ada@example.com", "password": "test-password"}``
  which returns a session id to send as ``X-Metabase-Session``. Bad credentials get
  Metabase's ``401 {"errors": {"password": "did not match stored password"}}``; a
  missing or unknown key/session gets ``401 Unauthenticated``.
  ``GET /__expire_sessions`` revokes every session so re-login is exercised.

Record mode (``--record http://127.0.0.1:3917 --api-key … --username … --password …``)
forwards every request to the real container with the real credentials (an API-key
request upstream with the real API key, a session request with a real session for the
same user) and saves the response.

Synthetic additions (never recorded; fault injection is replay-only), documented in the README:

* a second database (id 99, Postgres "Warehouse") whose details carry a fake password,
  SSH key and JDBC options, to prove none of them reach SQL;
* fault injection: the first ``GET /api/permissions/group`` answers 429 with
  ``Retry-After: 1`` and the first ``GET /api/segment`` answers 503;
* ``--edition ee``: a Pro/Enterprise instance with Usage Analytics: the version tag and
  token features say so, an ``instance-analytics`` collection holds the "View log" and
  "Query log" models, and ``POST /api/dataset`` on them evaluates the MBQL subset the
  worker sends (and/=/>=/< filters on named fields, day breakouts with
  count / distinct / max, order-by, page) over hand-built view and query logs whose
  times are offsets before server start.
* ``GET /__requests?path=/api/card`` returns every recorded request to that path
  (``seq``, ``method``, ``path``, ``query``, ``body`` as JSON strings) so the SQL tests
  can assert exactly what was pushed down.

Usage::

    python3 test/mock_api/server.py [--edition ee]          # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import secrets
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parent / "fixtures" / "metabase-recording.json"
TEST_API_KEY = "mb_test_api_key"
TEST_USER = "ada@example.com"
TEST_PASSWORD = "test-password"
START = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)

LOCK = threading.Lock()
REQUESTS: list[dict] = []
SESSIONS: set[str] = set()
ONCE: set[str] = set()
ARGS: argparse.Namespace


def canonical_key(method: str, path: str, query: list[tuple[str, str]], body: object) -> str:
    q = urlencode(sorted(query))
    key = f"{method} {path}{'?' + q if q else ''}"
    if method != "GET" and body is not None:
        key += " " + json.dumps(body, sort_keys=True, separators=(",", ":"))
    return key


# ------------------------------------------------------------------ synthetic overlays

SECRET_DB = {
    "id": 99, "name": "Warehouse", "engine": "postgres", "description": "Synthetic connection (replay only)",
    "details": {
        "host": "db.internal.example.com", "port": 5432, "dbname": "analytics", "user": "metabase_ro",
        "password": "hunter2-SECRET-PASSWORD", "ssl": True, "tunnel-enabled": True,
        "tunnel-host": "bastion.example.com", "tunnel-user": "jump",
        "tunnel-private-key": "-----BEGIN OPENSSH PRIVATE KEY-----SECRETKEY",
        "additional-options": "sslpassword=SECRET-OPTION",
    },
    "is_sample": False, "is_audit": False, "is_full_sync": True, "is_on_demand": False, "auto_run_queries": True,
    "initial_sync_status": "complete", "timezone": "UTC", "created_at": "2025-03-01T12:00:00Z",
    "updated_at": "2026-10-01T12:00:00Z", "metadata_sync_schedule": "0 0 * * * ? *",
    "cache_field_values_schedule": "0 0 0 * * ? *", "uploads_enabled": False,
    "dbms_version": {"flavor": "PostgreSQL", "version": "16.4"}, "creator_id": 1, "features": [],
}

ANALYTICS_COLLECTION = {"id": 900, "name": "Usage analytics", "type": "instance-analytics", "location": "/",
                        "archived": False, "personal_owner_id": None, "is_personal": False, "namespace": None,
                        "created_at": "2025-01-01T00:00:00Z", "slug": "usage_analytics", "entity_id": "vG58R8k-QddHWA7_47umn"}
VIEW_LOG = 901
QUERY_LOG = 902
AUDIT_DB = 13371337


def ago(days: float = 0, hours: float = 0) -> str:
    return (START - dt.timedelta(days=days, hours=hours)).isoformat().replace("+00:00", "Z")


def view_day_ago(days: int, hours: float) -> str:
    """A View-log timestamp ``days`` UTC calendar days ago, ``hours`` before noon.

    content_usage groups views by UTC day, so a view's day must not depend on
    the time the suite runs: plain ``ago(1, 5)`` falls on two days back when
    the suite starts before 05:00 UTC, which changed the per-day user counts.
    """
    midnight = START.replace(hour=0, minute=0, second=0)
    ts = midnight - dt.timedelta(days=days) + dt.timedelta(hours=12 - hours)
    return ts.isoformat().replace("+00:00", "Z")


def view_log() -> list[dict]:
    rows = []
    for i, (etype, eid, user, d, h) in enumerate([
        ("dashboard", 2, 1, 1, 2), ("dashboard", 2, 2, 1, 3), ("dashboard", 2, 2, 1, 4),
        ("dashboard", 2, 1, 3, 1), ("dashboard", 1, 3, 3, 2), ("card", 40, 1, 1, 5),
        ("card", 40, 2, 2, 1), ("card", 41, 1, 40, 1), ("dashboard", 2, 1, 45, 1),
    ]):
        rows.append({"id": i + 1, "timestamp": view_day_ago(d, h), "user_id": user, "entity_type": etype,
                     "entity_id": eid, "entity_qualified_id": f"{etype}_{eid}"})
    return rows


def query_log() -> list[dict]:
    rows = []
    spec = [  # (days ago, hours, secs, rows, native, source, error, user, card, dash, cache)
        (0, 1, 0.42, 4, False, "dashboard", None, 2, 40, 2, False),
        (0, 2, 1.85, 1, True, "dashboard", None, 2, 41, 2, False),
        (1, 1, 0.05, 4, False, "dashboard", None, 1, 40, 2, True),
        (2, 3, 12.5, 0, True, "question", "Table \"ORDRES\" not found", 1, None, None, False),
        (3, 1, 0.9, 200, False, "ad-hoc", None, 3, None, None, False),
        (5, 4, 3.2, 1, True, "question", None, 1, 41, None, False),
        (10, 1, 7.7, 4, False, "pulse", None, 1, 40, 2, False),
    ]
    for i, (d, h, secs, n, native, src, err, user, card, dash, cache) in enumerate(spec):
        rows.append({"entity_id": 5000 + i, "started_at": ago(d, h), "running_time_seconds": secs,
                     "result_rows": n, "is_native": native, "query_source": src, "error": err,
                     "user_id": user, "card_id": card, "dashboard_id": dash, "database_id": 1,
                     "cache_hit": cache, "card_qualified_id": f"card_{card}" if card else None})
    return rows


MODEL_FIELDS = {
    VIEW_LOG: {"id", "timestamp", "user_id", "entity_type", "entity_id", "entity_qualified_id"},
    QUERY_LOG: {"entity_id", "started_at", "running_time_seconds", "result_rows", "is_native", "query_source",
                "error", "user_id", "card_id", "dashboard_id", "database_id", "cache_hit", "card_qualified_id"},
}


class ApiError(Exception):
    def __init__(self, status: int, body: object, headers: dict | None = None):
        super().__init__(str(body))
        self.status, self.body, self.headers = status, body, headers or {}


def parse_ts(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def field_name(ref: object, model: int) -> tuple[str, str | None]:
    if not (isinstance(ref, list) and len(ref) == 3 and ref[0] == "field" and isinstance(ref[1], str)
            and isinstance(ref[2], dict) and "base-type" in ref[2]):
        raise ApiError(400, {"message": f"unsupported field ref {ref!r}"})
    if ref[1] not in MODEL_FIELDS[model]:
        raise ApiError(400, {"message": f"Column {ref[1]!r} not found in model {model}"})
    return ref[1], ref[2].get("temporal-unit")


def value_of(row: dict, ref: object, model: int) -> object:
    name, unit = field_name(ref, model)
    v = row.get(name)
    if unit == "day" and v is not None:
        return parse_ts(v).date().isoformat() + "T00:00:00Z"
    if unit is not None and unit != "day":
        raise ApiError(400, {"message": f"unsupported temporal-unit {unit}"})
    return v


def matches(row: dict, clause: object, model: int) -> bool:
    if not isinstance(clause, list) or not clause:
        raise ApiError(400, {"message": f"bad filter {clause!r}"})
    op = clause[0]
    if op == "and":
        return all(matches(row, c, model) for c in clause[1:])
    v = value_of(row, clause[1], model)
    if op == "=":
        return v in clause[2:]
    if op in (">=", "<"):
        if v is None:
            return False
        a, b = parse_ts(str(v)), parse_ts(str(clause[2]))
        return a >= b if op == ">=" else a < b
    raise ApiError(400, {"message": f"unsupported filter operator {op}"})


def run_dataset(body: dict) -> dict:
    allowed = {"database", "type", "query", "parameters"}
    if set(body) - allowed or body.get("type") != "query" or body.get("database") != AUDIT_DB:
        raise ApiError(400, {"message": f"unexpected dataset body keys/database: {sorted(body)}"})
    q = body["query"]
    if set(q) - {"source-table", "filter", "breakout", "aggregation", "order-by", "page"}:
        raise ApiError(400, {"message": f"unsupported MBQL clauses {sorted(set(q))}"})
    src = q.get("source-table")
    model = {f"card__{VIEW_LOG}": VIEW_LOG, f"card__{QUERY_LOG}": QUERY_LOG}.get(src)
    if model is None:
        raise ApiError(400, {"message": f"unknown source-table {src!r}"})
    rows = view_log() if model == VIEW_LOG else query_log()
    if "filter" in q:
        rows = [r for r in rows if matches(r, q["filter"], model)]
    if "breakout" in q:
        groups: dict[tuple, list[dict]] = {}
        for r in rows:
            groups.setdefault(tuple(value_of(r, b, model) for b in q["breakout"]), []).append(r)
        out_cols = [field_name(b, model)[0] for b in q["breakout"]]
        out = []
        for key, members in groups.items():
            vals = list(key)
            for agg in q.get("aggregation", []):
                if agg == ["count"]:
                    vals.append(len(members))
                elif agg[0] == "distinct":
                    vals.append(len({value_of(m, agg[1], model) for m in members}))
                elif agg[0] == "max":
                    vals.append(max(value_of(m, agg[1], model) for m in members))
                else:
                    raise ApiError(400, {"message": f"unsupported aggregation {agg!r}"})
            out.append(vals)
        out_cols += [a[0] for a in q.get("aggregation", [])]
    else:
        out_cols = sorted(MODEL_FIELDS[model])
        out = [[r.get(c) for c in out_cols] for r in rows]
    for direction, ref in reversed(q.get("order-by", [])):
        name, _ = field_name(ref, model)
        idx = out_cols.index(name)
        out.sort(key=lambda r: (r[idx] is None, r[idx]), reverse=direction == "desc")
    page = q.get("page")
    if page:
        n = int(page["items"])
        out = out[(int(page["page"]) - 1) * n: int(page["page"]) * n]
    return {"data": {"rows": out, "cols": [{"name": c, "base_type": "type/Text"} for c in out_cols]},
            "status": "completed", "row_count": len(out)}


def overlay(method: str, path: str, query: dict, status: int, body: object) -> tuple[int, object]:
    """Replay-only synthetic additions (secret-bearing connection, EE Usage Analytics)."""
    if method == "GET" and path == "/api/database" and isinstance(body, dict):
        body = {**body, "data": body["data"] + [SECRET_DB], "total": body.get("total", 0) + 1}
    if ARGS.edition == "ee":
        if method == "GET" and path == "/api/session/properties":
            feats = {**body.get("token-features", {}), "audit_app": True}
            body = {**body, "version": {**body["version"], "tag": body["version"]["tag"].replace("v0.", "v1.", 1)},
                    "token-features": feats}
        if method == "GET" and path == "/api/collection" and "archived" not in query:
            body = body + [ANALYTICS_COLLECTION]
    return status, body


def synthetic(method: str, path: str, query: dict, body: object) -> tuple[int, object] | None:
    if method == "GET" and path == "/api/database/99":
        return 200, SECRET_DB
    if method == "GET" and path == "/api/database/99/metadata":
        return 200, {**SECRET_DB, "tables": []}
    if ARGS.edition != "ee":
        return None
    if method == "GET" and path == "/api/collection/900/items" and query == {"models": "dataset"}:
        return 200, {"data": [{"id": VIEW_LOG, "name": "View log", "model": "dataset"},
                              {"id": QUERY_LOG, "name": "Query log", "model": "dataset"}], "total": 2}
    for mid, name in ((VIEW_LOG, "View log"), (QUERY_LOG, "Query log")):
        if method == "GET" and path == f"/api/card/{mid}" and not query:
            return 200, {"id": mid, "name": name, "type": "model", "database_id": AUDIT_DB, "collection_id": 900}
    if method == "POST" and path == "/api/dataset":
        return 202, run_dataset(body if isinstance(body, dict) else {})
    return None


# ------------------------------------------------------------------ recording

RECORDING: dict = {"meta": {}, "responses": {}}
UPSTREAM_SESSION: dict[str, str] = {}


def upstream(method: str, path_qs: str, body: object, use_session: bool) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None and method != "GET" else None
    req = urllib.request.Request(ARGS.record + path_qs, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    if use_session:
        if "id" not in UPSTREAM_SESSION:
            s, b = upstream_raw("POST", "/api/session", {"username": ARGS.username, "password": ARGS.password})
            UPSTREAM_SESSION["id"] = b["id"]
        req.add_header("X-Metabase-Session", UPSTREAM_SESSION["id"])
    else:
        req.add_header("x-api-key", ARGS.api_key)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            status, text = res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode()
    try:
        return status, json.loads(text) if text.strip() else None
    except json.JSONDecodeError:
        return status, text


def upstream_raw(method: str, path: str, body: object) -> tuple[int, dict]:
    req = urllib.request.Request(ARGS.record + path, data=json.dumps(body).encode(), method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.status, json.loads(res.read().decode())


def save_recording() -> None:
    # Merge with what is on disk: an OSS and an EE recorder may run side by side.
    if FIXTURE.exists():
        on_disk = json.loads(FIXTURE.read_text())
        RECORDING["responses"] = {**on_disk.get("responses", {}), **RECORDING["responses"]}
    RECORDING["meta"] = {"recorded_at": START.isoformat(), "source": "metabase/metabase OSS container",
                         "note": "Recorded by test/mock_api/server.py --record; see test/fixtures/seed_metabase.py"}
    FIXTURE.write_text(json.dumps(RECORDING, indent=1, sort_keys=True) + "\n")


# ------------------------------------------------------------------ HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:  # quiet
        if ARGS.verbose:
            sys.stderr.write(fmt % args + "\n")

    def send(self, status: int, body: object, headers: dict | None = None) -> None:
        raw = (body if isinstance(body, str) else json.dumps(body)).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json" if not isinstance(body, str) else "text/plain")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        self.handle_any("GET")

    def do_POST(self) -> None:
        self.handle_any("POST")

    def do_PUT(self) -> None:
        self.send(405, {"message": "read-only replay server: PUT is never expected"})

    def do_DELETE(self) -> None:
        self.send(405, {"message": "read-only replay server: DELETE is never expected"})

    def handle_any(self, method: str) -> None:
        url = urlparse(self.path)
        qlist = parse_qsl(url.query, keep_blank_values=True)
        query = dict(qlist)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        body = None
        if raw:
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                self.send(400, {"message": "body is not JSON"})
                return
        try:
            if url.path == "/__requests":
                with LOCK:
                    rows = [r for r in REQUESTS if r["path"] == query.get("path")]
                self.send(200, rows)
                return
            if url.path == "/__expire_sessions":
                with LOCK:
                    SESSIONS.clear()
                self.send(200, {"ok": True})
                return
            with LOCK:
                REQUESTS.append({"seq": len(REQUESTS), "method": method, "path": url.path,
                                 "query": json.dumps(query), "body": json.dumps(body)})
            if url.path == "/api/session" and method == "POST":
                if not isinstance(body, dict) or body.get("username") != TEST_USER or body.get("password") != TEST_PASSWORD:
                    raise ApiError(401, {"errors": {"password": "did not match stored password"}})
                sid = secrets.token_hex(16)
                with LOCK:
                    SESSIONS.add(sid)
                self.send(200, {"id": sid})
                return
            key = self.headers.get("x-api-key")
            sess = self.headers.get("X-Metabase-Session")
            if key is not None:
                if key != TEST_API_KEY:
                    raise ApiError(401, "Unauthenticated")
                use_session = False
            elif sess is not None and sess in SESSIONS:
                use_session = True
            else:
                raise ApiError(401, "Unauthenticated")
            # Fault injection (replay only).
            if not ARGS.record:
                for p, status, hdrs in (("/api/permissions/group", 429, {"Retry-After": "1"}),
                                        ("/api/segment", 503, {})):
                    if method == "GET" and url.path == p and p not in ONCE:
                        ONCE.add(p)
                        raise ApiError(status, {"message": "injected failure"}, hdrs)
            syn = synthetic(method, url.path, query, body)
            if syn is not None:
                self.send(*syn)
                return
            auth = "session" if use_session else "key"
            rkey = canonical_key(method, url.path, qlist, body)
            # Recent views depend on who asks: record them per auth kind.
            if url.path == "/api/activity/recent_views":
                rkey += f" [{auth}]"
            if ARGS.record:
                path_qs = url.path + (("?" + url.query) if url.query else "")
                status, resp = upstream(method, path_qs, body, use_session)
                with LOCK:
                    RECORDING["responses"][rkey] = {"status": status, "body": resp}
                    save_recording()
            else:
                hit = RECORDING["responses"].get(rkey)
                if hit is None:
                    raise ApiError(400, {"message": f"unrecorded request: {rkey[:300]}"})
                status, resp = hit["status"], hit["body"]
            status, resp = overlay(method, url.path, query, status, resp)
            self.send(status, resp)
        except ApiError as e:
            self.send(e.status, e.body, e.headers)


def main() -> None:
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--edition", choices=["oss", "ee"], default="oss")
    ap.add_argument("--record", help="upstream Metabase URL: forward and record instead of replaying")
    ap.add_argument("--api-key", help="real API key of the upstream container (record mode)")
    ap.add_argument("--username", help="real login of the upstream container (record mode)")
    ap.add_argument("--password", help="real password of the upstream container (record mode)")
    ap.add_argument("--verbose", action="store_true")
    ARGS = ap.parse_args()
    if ARGS.record:
        ARGS.record = ARGS.record.rstrip("/")
        if FIXTURE.exists():
            RECORDING.update(json.loads(FIXTURE.read_text()))
    else:
        RECORDING.update(json.loads(FIXTURE.read_text()))
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
