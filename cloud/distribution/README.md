# RH Runner for Linux

A headless application controlled through a local API.

Requires Linux, a current Node.js 22 or 24 LTS release, npm and Python 3.
Speech is saved as stereo WAV; no ffmpeg dependency.

```sh
bash install.sh
cd ~/rh-runner-cloud
python3 scripts/accounts.py import /path/to/rh-accounts.json
python3 smoke/smoke_test.py --dir .
```

Use `bash install.sh --dir /absolute/path --port 17863 --no-service` for a manual installation.
Manual launch: enter `current/`, set `RH_DATA_DIR` to the installation's `data/` directory, then run `npm start`.

The installer builds a new release before switching the service. Existing data remains in `data/`.
Back up the complete data directory, including `secrets.key`, before upgrading.
Only one process may use the same database at a time.

API access is local and token authenticated. Imported account files contain credentials; keep them private.
There is no graphical frontend or proxy setting. A managed cloud platform's proxy and CA environment can be inherited for network access.
The API uses `www.runninghub.ai`.

Read `AGENT_GUIDE.md` and `VIDEO_GUIDE.md` for usage. The smoke test is read-only by default;
`--tts` and `--video` perform real generation and must be explicitly authorized.

Docker deployment: `cd app && docker compose -f cloud/compose.yaml up -d --build`.
The Docker data volume must be retained during upgrades.
