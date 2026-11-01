#!/usr/bin/env python3
"""Check for a newer RH Runner Cloud distribution before the service starts.

Feed resolution order:
  1. $RH_UPDATE_URL
  2. update.json next to this script's parent dir: {"feed": "https://.../version.json"}
  3. no feed configured -> prints one line and exits 0 (never blocks startup).

Feed format: JSON {"version": "1.1.1-distribution.12", "url": "...", "notes": "..."}
or plain text whose first line is the version string.

When a newer version exists, writes data/update-notice.json and prints a
banner. The notice is how the operator's agent learns about the update and
reminds the user. Exit code is always 0.
"""
import json, os, re, sys, urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def local_version():
    try:
        text = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"(\d+)\.(\d+)\.(\d+)(?:-distribution\.(\d+))?", text)
    if not m:
        return None
    return tuple(int(x) if x is not None else 0 for x in m.groups()), text.split()[0]

def feed_url():
    url = os.environ.get("RH_UPDATE_URL", "").strip()
    if url:
        return url
    try:
        cfg = json.load(open(os.path.join(ROOT, "update.json"), encoding="utf-8"))
        return str(cfg.get("feed", "")).strip()
    except Exception:
        return "https://api.github.com/repos/chiqi51386-afk/RunningHub-Multi-Task-Runner/releases/latest"

def fetch(url):
    if url.startswith("file://"):
        with open(url[7:], encoding="utf-8") as f:
            return f.read()
    req = urllib.request.Request(url, headers={"User-Agent": "rh-runner-update-check"})
    with urllib.request.urlopen(req, timeout=6) as resp:
        text = resp.read(1024 * 1024 + 1)
        if len(text) > 1024 * 1024: raise ValueError("update feed too large")
        return text.decode("utf-8", "replace")

def parse_remote(text):
    text = text.strip()
    try:
        data = json.loads(text)
        if "tag_name" in data:
            if data.get("draft") or data.get("prerelease"): return "", "", ""
            asset = next((a for a in data.get("assets", []) if a.get("name", "").endswith("-linux.zip")), None)
            if not asset: return "", "", ""
            return data["tag_name"].lstrip("v"), asset["browser_download_url"], "Linux update."
        return str(data.get("version", "")), str(data.get("url", "")), str(data.get("notes", ""))
    except Exception:
        return text.splitlines()[0].strip() if text else "", "", ""

def version_key(v):
    m = re.search(r"(\d+)\.(\d+)\.(\d+)(?:-distribution\.(\d+))?", v or "")
    return tuple(int(x) if x is not None else 0 for x in m.groups()) if m else None

def main():
    notice_path = os.path.join(os.environ.get("RH_DATA_DIR", os.path.join(ROOT, "data")), "update-notice.json")
    if "--clear" in sys.argv:
        try:
            os.remove(notice_path)
        except OSError:
            pass
        print("update notice cleared")
        return 0
    lv = local_version()
    url = feed_url()
    if not url:
        print("update check: no feed configured (set RH_UPDATE_URL or update.json), skipped")
        return 0
    if lv is None:
        print("update check: local VERSION unreadable, skipped")
        return 0
    try:
        remote_version, dl, notes = parse_remote(fetch(url))
    except Exception as e:
        print(f"update check: feed unreachable ({e}), skipped")
        return 0
    rk, lk = version_key(remote_version), lv[0]
    if rk and lk and rk > lk:
        notice = {"current": lv[1], "latest": remote_version, "url": dl, "notes": notes,
                  "checkedAt": datetime.now(timezone.utc).isoformat()}
        try:
            os.makedirs(os.path.dirname(notice_path), exist_ok=True)
            with open(notice_path, "w", encoding="utf-8") as f:
                json.dump(notice, f, ensure_ascii=False, indent=1)
        except OSError:
            pass
        print("=" * 60)
        print(f"UPDATE AVAILABLE: {lv[1]} -> {remote_version}")
        if notes:
            print(f"notes: {notes}")
        if dl:
            print(f"download: {dl}")
        print("Tell the user to update. Notice written to data/update-notice.json")
        print("=" * 60)
    elif rk:
        try: os.remove(notice_path)
        except FileNotFoundError: pass
        print(f"update check: up to date ({lv[1]})")
    else:
        print("update check: Linux release not ready, skipped")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
