#!/usr/bin/env python3
"""Account management for RH Runner Cloud (RunningHub overseas site + Gemini).

All commands go through the local cloud API (127.0.0.1:17863) and never print
full API keys. Keys are read from a file or an interactive prompt, never from
command-line arguments (which would leak into shell history / process lists).

Usage:
  python3 scripts/accounts.py list [--state IDLE]
  python3 scripts/accounts.py import rh-accounts.json        # bulk import (dedup: existing keys skipped)
  python3 scripts/accounts.py add-rh "label" --key-file key.txt [--test]
  python3 scripts/accounts.py add-gemini --key-file keys.txt  # one key per line
  python3 scripts/accounts.py test <account-id|label>
  python3 scripts/accounts.py test-all
  python3 scripts/accounts.py patch <id> [--enable|--disable] [--preferred|--no-preferred] [--concurrency N]
  python3 scripts/accounts.py remove <id>
  python3 scripts/accounts.py gemini-remove <key-id>

Env: RH_BASE_URL (default http://127.0.0.1:17863),
     RH_TOKEN_FILE (default <repo>/data/api.token, binary; sent hex-encoded)
"""
import argparse, getpass, json, os, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
BASE = os.environ.get("RH_BASE_URL", "http://127.0.0.1:17863")

def token():
    return Path(os.environ.get("RH_TOKEN_FILE", HERE / "data" / "api.token")).read_bytes().hex()

def api(method, endpoint, body=None, timeout=900):
    data = json.dumps(body).encode() if body is not None else (b"{}" if method in ("POST", "PATCH") else None)
    req = urllib.request.Request(BASE + endpoint, data=data, method=method,
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def read_keys(path):
    if path:
        return [ln.strip() for ln in Path(path).read_text(encoding="utf-8").splitlines() if ln.strip()]
    return [getpass.getpass("API key (hidden): ").strip()]

def find_account(ref):
    for a in api("GET", "/accounts")["runninghub"]:
        if a["id"] == ref or a["label"] == ref:
            return a
    raise SystemExit(f"account not found: {ref}")

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list"); p.add_argument("--state")
    p = sub.add_parser("import"); p.add_argument("file")
    p = sub.add_parser("add-rh"); p.add_argument("label"); p.add_argument("--key-file"); p.add_argument("--test", action="store_true")
    p = sub.add_parser("add-gemini"); p.add_argument("--key-file")
    p = sub.add_parser("test"); p.add_argument("ref")
    sub.add_parser("test-all")
    p = sub.add_parser("patch"); p.add_argument("ref")
    g = p.add_mutually_exclusive_group(); g.add_argument("--enable", action="store_true"); g.add_argument("--disable", action="store_true")
    g2 = p.add_mutually_exclusive_group(); g2.add_argument("--preferred", action="store_true"); g2.add_argument("--no-preferred", action="store_true")
    p.add_argument("--concurrency", type=int)
    p = sub.add_parser("remove"); p.add_argument("ref")
    p = sub.add_parser("gemini-remove"); p.add_argument("id")
    args = ap.parse_args()

    if args.cmd == "list":
        d = api("GET", "/accounts")
        for a in d["runninghub"]:
            if args.state and a["state"] != args.state: continue
            print(f"{a['label']:<12} {a['state']:<16} coins={a.get('coins')} enabled={a['enabled']} preferred={a['preferred']} id={a['id']}")
        g = d["gemini"]
        print(f"Gemini keys: {len(g['keys'])} (model={g['model']}, optimizationEnabled={g['optimizationEnabled']})")
        for k in g["keys"]:
            print(f"  {k['label']:<12} {k.get('state')} enabled={k['enabled']} {k['maskedKey']} id={k['id']}")
    elif args.cmd == "import":
        body = json.loads(Path(args.file).read_text(encoding="utf-8"))
        print(api("POST", "/accounts/import", body))
    elif args.cmd == "add-rh":
        key = read_keys(args.key_file)[0]
        acc = api("POST", "/accounts/runninghub", {"label": args.label, "apiKey": key})
        print(f"added: {acc['label']} id={acc['id']} state={acc['state']}")
        if args.test:
            acc = api("POST", f"/accounts/{acc['id']}/test")
            print(f"tested: state={acc['state']} coins={acc.get('coins')} autoDisabled={acc['autoDisabled']}")
    elif args.cmd == "add-gemini":
        keys = read_keys(args.key_file)
        d = api("POST", "/accounts/gemini", {"keys": keys})
        print(f"gemini keys now: {len(d['keys'])}")
    elif args.cmd == "test":
        acc = find_account(args.ref)
        acc = api("POST", f"/accounts/{acc['id']}/test")
        print(f"{acc['label']}: state={acc['state']} coins={acc.get('coins')} balance={acc.get('balance')}")
    elif args.cmd == "test-all":
        res = api("POST", "/accounts/test-all")
        from collections import Counter
        print(f"tested {len(res)} accounts:", dict(Counter(a["state"] for a in res)))
    elif args.cmd == "patch":
        acc = find_account(args.ref)
        body = {}
        if args.enable: body["enabled"] = True
        if args.disable: body["enabled"] = False
        if args.preferred: body["preferred"] = True
        if args.no_preferred: body["preferred"] = False
        if args.concurrency is not None: body["maxConcurrency"] = args.concurrency
        if not body: raise SystemExit("nothing to patch")
        acc = api("PATCH", f"/accounts/{acc['id']}", body)
        print(f"{acc['label']}: enabled={acc['enabled']} preferred={acc['preferred']} maxConcurrency={acc['maxConcurrency']}")
    elif args.cmd == "remove":
        acc = find_account(args.ref)
        print(api("DELETE", f"/accounts/{acc['id']}"))
    elif args.cmd == "gemini-remove":
        d = api("POST", "/gemini/remove", {"id": args.id})
        print(f"gemini keys now: {len(d['keys'])}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
