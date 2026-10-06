$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('rh-source-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
# Explicit source allowlist: never copy a workspace or user-data directory wholesale.
$folders = @('src', 'tests', 'desktop', 'bundled-workflows', 'prompt-skills', 'THIRD_PARTY_LICENSES', '.github', 'frontend/src', 'frontend/tests')
foreach ($folder in $folders) {
  $destination = Join-Path $staging $folder
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) | Copy-Item -Destination $destination -Recurse
}
$files = @('package.json','package-lock.json','tsconfig.json','.gitignore','README.md','KNOWN_ISSUES.md','Start RunningHub Runner.cmd','SECURITY_AUDIT_v1.1.0.md','RELEASE_REVIEW_v1.1.0.md','RELEASE_NOTES_v1.1.0.md',
  'frontend/package.json','frontend/package-lock.json','frontend/index.html','frontend/tsconfig.json','frontend/vite.config.ts',
  'scripts/ensure-electron-native.mjs','scripts/generate-third-party-licenses.mjs','scripts/verify-package-boundaries.mjs',
  'scripts/package-windows.ps1','scripts/export-source.ps1','scripts/security-scan.mjs','scripts/security-encryption-smoke.cjs','scripts/dev.ts','scripts/integration.ts',
  'scripts/diagnose-account.cjs','scripts/test-frontend-performance.cjs')
foreach ($file in $files) {
  $source = Join-Path $projectRoot $file
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing source file: $file" }
  $destination = Join-Path $staging $file
  New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination
}
$prohibited = Get-ChildItem -LiteralPath $staging -Recurse -File | Where-Object { $_.Name -match '\.sqlite|^\.env|\.log$|\.mp4$|\.mp3$|\.png$|\.jpg$' -and $_.FullName -ne (Join-Path $staging 'desktop/assets/icon.png') }
if ($prohibited) { throw 'Unexpected data/media files in source archive' }
$archive = Join-Path $projectRoot "release-build/RunningHub-Runner-v$version-source.zip"
New-Item -ItemType Directory -Path (Split-Path $archive) -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $archive) { throw "Archive already exists: $archive" }
[System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $archive)
Write-Output "SOURCE_ARCHIVE=$archive"
Write-Output "SOURCE_STAGING=$staging"
Get-FileHash -LiteralPath $archive -Algorithm SHA256
