#!/usr/bin/env python3
"""Smoke test for an installed RH Runner Cloud.

Read-only checks by default: /health, /workflows, /accounts.
Optional billable checks:
  --tts    one short English TTS sample (uses a Gemini key, no RH coins)
  --video  one 4-second first/last-frame video with the bundled frames
           (costs roughly 60 RunningHub coins on the overseas site)

Usage: python3 smoke/smoke_test.py --dir ~/rh-runner-cloud [--tts] [--video]
Env: RH_BASE_URL (default http://127.0.0.1:17863)
"""
import argparse, json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(Path.home() / "rh-runner-cloud"))
    ap.add_argument("--tts", action="store_true")
    ap.add_argument("--video", action="store_true")
    args = ap.parse_args()

    root = Path(args.dir).expanduser()
    base = os.environ.get("RH_BASE_URL", "http://127.0.0.1:17863")
    token = (root / "data" / "api.token").read_bytes().hex()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def api(method, endpoint, body=None, raw_out=None, timeout=300):
        data = None
        headers = {"Authorization": "Bearer " + token}
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = bytes(body)
            else:
                data = json.dumps(body).encode(); headers["Content-Type"] = "application/json"
        elif method in ("POST", "PATCH"):
            data = b"{}"; headers["Content-Type"] = "application/json"
        req = urllib.request.Request(base + endpoint, data=data, method=method, headers=headers)
        with opener.open(req, timeout=timeout) as resp:
            payload = resp.read()
        if raw_out:
            Path(raw_out).write_bytes(payload); return {"saved": str(raw_out), "bytes": len(payload)}
        return json.loads(payload.decode("utf-8"))

    out_dir = root / "smoke" / "out"; out_dir.mkdir(parents=True, exist_ok=True)

    health = api("GET", "/health")
    assert health.get("ready"), f"health not ready: {health}"
    print(f"[ok] health: {health}")

    workflows = api("GET", "/workflows")
    print(f"[ok] workflows: {len(workflows)}")
    wf = next((w for w in workflows if w["id"] == "builtin:h3-first-last.rhworkflow.json"), None)
    assert wf, "first/last-frame workflow missing"

    accounts = api("GET", "/accounts")
    rh, gem = accounts["runninghub"], accounts["gemini"]["keys"]
    usable = sum(1 for a in rh if a["enabled"] and not a["autoDisabled"] and str(a.get("coins") or "0") not in ("0", ""))
    print(f"[ok] accounts: runninghub={len(rh)} (usable~{usable}) gemini={len(gem)}")

    if args.tts:
        rid = f"smoke-tts-{int(time.time())}"
        api("POST", "/tts", {"requestId": rid, "input": {
            "text": "Hello, this is a smoke test of the speech service.",
            "voice": "Puck", "language": "en", "style": "Cheerful and clear."}})
        for _ in range(40):
            time.sleep(5)
            state = api("GET", f"/tts/{rid}")
            if state and state.get("state") == "completed": break
            if state and state.get("state") == "failed": raise SystemExit("TTS failed")
        else:
            raise SystemExit("TTS timed out")
        got = api("GET", f"/tts/{rid}/audio", raw_out=out_dir / "smoke-tts.wav")
        print(f"[ok] tts: {got}")

    if args.video:
        if usable == 0: raise SystemExit("no usable RunningHub account with coins; run scripts/check_credits.py")
        assets = Path(__file__).resolve().parent / "assets"
        up = {}
        for name in ("test1-first.jpg", "test1-last.jpg"):
            up[name] = api("POST", f"/uploads?filename={name}", body=(assets / name).read_bytes())["localPath"]
        rid = f"smoke-video-{int(time.time())}"
        job = {"workflowId": wf["id"], "taskName": "smoke-首尾帧4秒",
               "parameters": {"duration": 4, "aspect_ratio": "9:16 (Portrait Widescreen)",
                              "prompt": "A lighthouse on a rocky coast, the sun sets over the sea, the sky turns orange and purple, the lighthouse lamp lights up, smooth cinematic transition from the first frame to the last frame."},
               "media": [{"parameterId": "image", "localPath": up["test1-first.jpg"]},
                         {"parameterId": "image_2", "localPath": up["test1-last.jpg"]}],
               "optimize": False, "instanceType": "default"}
        res = api("POST", "/jobs", {"requestId": rid, "jobs": [job]})
        job_id = res["jobIds"][0]
        print(f"[..] video job submitted: {job_id} (requestId={rid}); polling...")
        for _ in range(240):  # up to ~20 min
            time.sleep(5)
            j = api("GET", f"/jobs/{job_id}")
            if j["status"] == "COMPLETED":
                f0 = j["outputs"]["files"][0]
                print(f"[ok] video completed: {f0['localPath']}")
                break
            if j["status"] in ("FAILED", "CANCELLED", "SUBMIT_UNKNOWN"):
                raise SystemExit(f"video job ended as {j['status']}: {j.get('lastError')}")
        else:
            raise SystemExit("video polling timed out; check GET /jobs/" + job_id)

    print("SMOKE TEST PASSED")
    return 0

if __name__ == "__main__":
    sys.exit(main())
