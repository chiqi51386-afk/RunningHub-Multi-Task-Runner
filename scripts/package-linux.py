"""Build the Linux distribution from reviewed shared sources, never local user data."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
target = root / 'release-build' / f'RunningHub-Runner-v{version}-linux.zip'
target.parent.mkdir(exist_ok=True)
files = {}
for directory in ['src/core', 'src/cloud', 'bundled-workflows', 'prompt-skills', 'THIRD_PARTY_LICENSES']:
    for file in (root / directory).rglob('*'):
        if file.is_file(): files['app/' + file.relative_to(root).as_posix()] = file.read_bytes()
for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'Dockerfile', 'compose.yaml', 'client.py', 'README.md']:
    files['app/cloud/' + name] = (root / 'cloud' / name).read_bytes()
for name in ['package.json', 'package-lock.json']:
    files['app/' + name] = (root / 'cloud' / name).read_bytes()
for file in (root / 'cloud/distribution').rglob('*'):
    if file.is_file() and '__pycache__' not in file.parts:
        files[file.relative_to(root / 'cloud/distribution').as_posix()] = file.read_bytes()
files['VERSION'] = (version + '\n').encode()
checksums = []
for name, value in sorted(files.items()):
    if name.endswith(('.py', '.sh', '.md', '.json', '.ts', '.yaml')):
        files[name] = value.replace(b'\r\n', b'\n')
    checksums.append(hashlib.sha256(files[name]).hexdigest() + '  ' + name)
files['SHA256SUMS'] = ('\n'.join(checksums) + '\n').encode()
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, value in sorted(files.items()):
        info = zipfile.ZipInfo('RH-Runner-Cloud/' + name)
        info.external_attr = (0o100755 if name.endswith('.sh') else 0o100644) << 16
        archive.writestr(info, value, compress_type=zipfile.ZIP_DEFLATED)
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(target.parent / 'SHA256SUMS-linux.txt').write_text(f'{digest}  {target.name}\n', encoding='ascii')
print(target)
