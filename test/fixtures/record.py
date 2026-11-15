#!/usr/bin/env python3
"""Re-record test/fixtures/metabase-recording.json from a live, seeded Metabase container.

    # 1. start and seed a container (see seed_metabase.py), keep its output:
    python3 test/fixtures/seed_metabase.py http://127.0.0.1:3917 > /tmp/seed.json
    # 2. record every request the SQL tests make:
    python3 test/fixtures/record.py http://127.0.0.1:3917 /tmp/seed.json

It deletes the old recording, starts two recording proxies (test/mock_api/server.py
--record, one per edition) in front of the container, extracts every SQL statement from
test/sql/*.test, substitutes the env placeholders and runs them through the Haybarn CLI
against the worker. Assertions are not checked here (run `make test-sql` afterwards).
The container's real credentials stay in the proxies' memory; the recording holds only
response bodies.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HAYBARN = os.environ.get("HAYBARN_CLI", "uvx -q --from haybarn-cli==2.0.0rc11 haybarn -no-agent")


def statements(test: Path) -> list[str]:
    out, cur, in_sql = [], [], False
    for line in test.read_text().splitlines():
        if re.match(r"^(statement|query)\b", line):
            in_sql, cur = True, []
            continue
        if in_sql and (line.strip() == "" or line.strip() == "----"):
            if cur:
                out.append("\n".join(cur))
            in_sql, cur = False, []
            continue
        if in_sql:
            cur.append(line)
    if in_sql and cur:
        out.append("\n".join(cur))
    return out


def start(args: list[str]) -> tuple[subprocess.Popen, str]:
    p = subprocess.Popen([sys.executable, str(ROOT / "test/mock_api/server.py"), *args],
                         stdout=subprocess.PIPE, text=True)
    line = p.stdout.readline() if p.stdout else ""
    m = re.match(r"PORT:(\d+)", line)
    if not m:
        p.kill()
        raise SystemExit(f"server did not start: {line!r}")
    return p, f"http://127.0.0.1:{m.group(1)}"


def main() -> None:
    upstream, seed_file = sys.argv[1], sys.argv[2]
    seed = json.loads(Path(seed_file).read_text())
    creds = ["--record", upstream, "--api-key", seed["api_key"], "--username", seed["admin"]["email"],
             "--password", seed["admin"]["password"]]
    fixture = ROOT / "test/fixtures/metabase-recording.json"
    fixture.unlink(missing_ok=True)
    oss, oss_url = start(creds)
    ee, ee_url = start([*creds, "--edition", "ee"])
    try:
        env = {"METABASE_WORKER": str(ROOT / "bin/vgi-metabase-worker"), "METABASE_FIXTURE_URL": oss_url,
               "METABASE_EE_FIXTURE_URL": ee_url}
        sql = ["LOAD vgi;"]
        for t in sorted((ROOT / "test/sql").glob("*.test")):
            for s in statements(t):
                for k, v in env.items():
                    s = s.replace("{" + k + "}", v)
                sql.append(s.rstrip().rstrip(";") + ";")
        script = "\n".join(sql) + "\n"
        res = subprocess.run(HAYBARN, shell=True, input=script, text=True, capture_output=True)
        sys.stderr.write(res.stdout[-4000:] + res.stderr[-4000:])
    finally:
        oss.terminate()
        ee.terminate()
    rec = json.loads(fixture.read_text())
    print(f"recorded {len(rec['responses'])} responses into {fixture.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
