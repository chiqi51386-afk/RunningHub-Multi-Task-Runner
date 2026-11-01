"""Local AI client; standard-library only. Never prints API-pool credentials."""
import argparse
import json
import os
from pathlib import Path
import urllib.request
import urllib.error

parser = argparse.ArgumentParser()
parser.add_argument('method', choices=['GET', 'POST', 'PATCH', 'DELETE'])
parser.add_argument('endpoint')
parser.add_argument('--file', help='JSON request body, e.g. exported rh-accounts.json')
parser.add_argument('--output', help='Save response/media to a local file')
parser.add_argument('--token-file', default=os.environ.get('RH_TOKEN_FILE', 'data/api.token'))
args = parser.parse_args()
if not args.endpoint.startswith('/') or args.endpoint.startswith('//'):
    parser.error('endpoint must start with one slash')
token = Path(args.token_file).read_bytes().hex()
body = Path(args.file).read_bytes() if args.file else None
request = urllib.request.Request(os.environ.get('RH_BASE_URL', 'http://127.0.0.1:17863').rstrip('/') + args.endpoint, data=body,
    method=args.method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
# Explicit direct local connection; do not inherit HTTP(S)_PROXY.
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(request, timeout=180) as response:
        if args.output:
            with open(args.output, 'wb') as target:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
        else:
            print(response.read().decode('utf-8'))
except urllib.error.HTTPError as error:
    print(error.read().decode('utf-8'))
    raise SystemExit(1)
