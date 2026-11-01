# Template used by install.sh (it fills in the real values).
# Manual installs: replace __DIR__ and __NODE__, then copy to
# /etc/systemd/system/rh-runner.service and run:
#   systemctl daemon-reload && systemctl enable --now rh-runner
[Unit]
Description=RH Runner Cloud (Linux)
After=network.target

[Service]
Type=simple
WorkingDirectory=__DIR__
Environment=RH_DATA_DIR=__DIR__/data
Environment=RH_BIND=127.0.0.1
Environment=RH_PORT=17863
Environment=RH_API_HOST=https://www.runninghub.ai
Environment=NODE_USE_ENV_PROXY=1
# If this machine reaches the internet through an intercepting egress proxy,
# the service also needs that proxy and its CA bundle, e.g.:
# Environment=http_proxy=http://proxy:3128
# Environment=https_proxy=http://proxy:3128
# Environment=NODE_EXTRA_CA_CERTS=/path/to/ca-bundle.pem
# Update check before every start (never blocks startup; writes
# data/update-notice.json and logs a banner when a newer version exists).
ExecStartPre=-/usr/bin/python3 __DIR__/scripts/check_update.py
ExecStart=__NODE__ dist/src/cloud/main.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
