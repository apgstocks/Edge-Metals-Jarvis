#!/usr/bin/env python3
# ── helpers/data/sqlite_bridge.py ──────────────────────────────────────────
# The python half of helpers/data/sqlEngine.js, used only when this Node has
# no node:sqlite. Standard library only — no pip, nothing to install on the VM.
#
#   build <db path> <json payload>      [{name, columns, rows:[[...]]}, ...]
#   buildfts <db path> <json payload>   {name, columns, rows:[[...]]} -> FTS5
#   query <db path> <limit>          SQL on stdin, JSON result on stdout
#
# The query connection is opened read-only (file:...?mode=ro), so a statement
# that got past the JavaScript guard still cannot write.
import json
import sqlite3
import sys


def build(db_path, payload_path):
    with open(payload_path) as fh:
        plan = json.load(fh)
    con = sqlite3.connect(db_path)
    try:
        for table in plan:
            cols = table.get("columns") or []
            if not cols:
                continue
            quoted = ", ".join('"%s"' % c.replace('"', '') for c in cols)
            con.execute('CREATE TABLE %s (%s)' % (table["name"], quoted))
            marks = ", ".join("?" * len(cols))
            con.executemany('INSERT INTO %s VALUES (%s)' % (table["name"], marks), table.get("rows") or [])
        con.commit()
    finally:
        con.close()


def build_fts(db_path, payload_path):
    with open(payload_path) as fh:
        plan = json.load(fh)
    cols = plan["columns"]
    con = sqlite3.connect(db_path)
    try:
        con.execute("CREATE VIRTUAL TABLE %s USING fts5(%s, tokenize = 'porter unicode61')"
                    % (plan["name"], ", ".join(cols)))
        con.executemany('INSERT INTO %s VALUES (%s)' % (plan["name"], ", ".join("?" * len(cols))),
                        plan.get("rows") or [])
        con.commit()
    finally:
        con.close()


def query(db_path, limit):
    sql = sys.stdin.read()
    con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    try:
        con.row_factory = sqlite3.Row
        cur = con.execute(sql)
        fetched = cur.fetchmany(limit + 1)
        rows = [dict(r) for r in fetched[:limit]]
        cols = list(rows[0].keys()) if rows else [d[0] for d in (cur.description or [])]
        print(json.dumps({"columns": cols, "rows": rows, "truncated": len(fetched) > limit}, default=str))
    finally:
        con.close()


if __name__ == "__main__":
    try:
        if sys.argv[1] == "build":
            build(sys.argv[2], sys.argv[3])
        elif sys.argv[1] == "buildfts":
            build_fts(sys.argv[2], sys.argv[3])
        elif sys.argv[1] == "query":
            query(sys.argv[2], int(sys.argv[3]))
        else:
            raise SystemExit("unknown command")
    except Exception as exc:  # reported as JSON so the caller can say it out loud
        print(json.dumps({"error": "%s: %s" % (type(exc).__name__, exc)}))
        raise SystemExit(1)
