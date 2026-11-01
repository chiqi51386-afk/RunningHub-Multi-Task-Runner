#!/usr/bin/env python3
"""Daily credit (coins) check for RH Runner Cloud.

Refreshes every RunningHub account through the local cloud API
(POST /accounts/test-all), then prints and archives a summary:
account counts by state, total coins, and per-account detail.
Standard library only. Never prints API keys.

Usage:
  python3 scripts/check_credits.py [--no-refresh] [--json]
Env:
  RH_BASE_URL   default http://127.0.0.1:17863
  RH_TOKEN_FILE default <repo>/data/api.token  (binary token; hex-encoded)
  RH_DATA_DIR   default <repo>/data            (history file location)
"""
import argparse, json, os, sys, urllib.request, urllib.error
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

def api(method, endpoint, token, timeout=900):
    req = urllib.request.Request(
        os.environ.get("RH_BASE_URL", "http://127.0.0.1:17863") + endpoint,
        data=b"{}" if method in ("POST", "PATCH") else None,
        method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # local API: never via proxy
    with opener.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-refresh", action="store_true", help="skip test-all, summarize current stored state")
    ap.add_argument("--json", action="store_true", help="print JSON summary instead of text")
    args = ap.parse_args()

    token_file = Path(os.environ.get("RH_TOKEN_FILE", HERE / "data" / "api.token"))
    token = token_file.read_bytes().hex()
    data_dir = Path(os.environ.get("RH_DATA_DIR", HERE / "data"))

    if not args.no_refresh:
        api("POST", "/accounts/test-all", token)
    data = api("GET", "/accounts", token)

    rh = data.get("runninghub", [])
    states = Counter(a.get("state") for a in rh)
    def num(v):
        try: return float(v)
        except (TypeError, ValueError): return 0.0
    coins_known = [a for a in rh if a.get("coins") is not None]
    total_coins = sum(num(a["coins"]) for a in coins_known)
    usable = [a for a in rh if a.get("enabled") and not a.get("autoDisabled") and num(a.get("coins")) > 0]
    gem = data.get("gemini", {}) or {}
    gkeys = gem.get("keys", []) if isinstance(gem, dict) else []

    summary = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "runninghub": {
            "total": len(rh),
            "enabled": sum(1 for a in rh if a.get("enabled")),
            "states": dict(states),
            "coinsKnownAccounts": len(coins_known),
            "totalCoins": total_coins,
            "usableAccounts": len(usable),
            "zeroCoinAccounts": sum(1 for a in coins_known if num(a["coins"]) <= 0),
        },
        "gemini": {
            "totalKeys": len(gkeys),
            "enabledKeys": sum(1 for k in gkeys if k.get("enabled")),
            "model": gem.get("model") if isinstance(gem, dict) else None,
            "optimizationEnabled": gem.get("optimizationEnabled") if isinstance(gem, dict) else None,
        },
        "accounts": [
            {"label": a.get("label"), "state": a.get("state"), "coins": a.get("coins"),
             "balance": a.get("balance"), "enabled": a.get("enabled"), "autoDisabled": a.get("autoDisabled")}
            for a in rh
        ],
    }

    data_dir.mkdir(parents=True, exist_ok=True)
    hist = data_dir / "credits-history.jsonl"
    with hist.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({k: summary[k] for k in ("checkedAt", "runninghub", "gemini")}, ensure_ascii=False) + "\n")

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        r = summary["runninghub"]
        print(f"积分查询 {summary['checkedAt']}")
        print(f"RunningHub 账号: {r['total']}（启用 {r['enabled']}） 状态: {r['states']}")
        print(f"总金币: {r['totalCoins']:.0f}（已查 {r['coinsKnownAccounts']} 个账号，其中 0 金币 {r['zeroCoinAccounts']} 个，可用账号 {r['usableAccounts']} 个）")
        print(f"Gemini Key: {summary['gemini']['totalKeys']}（启用 {summary['gemini']['enabledKeys']}） 模型: {summary['gemini']['model']}")
        print(f"历史已记录到 {hist}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
