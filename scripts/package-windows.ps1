$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = Join-Path $projectRoot "release-build"
$unpacked = Join-Path $releaseRoot "win-unpacked"
$version = (Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$archive = Join-Path $releaseRoot "RunningHub-Runner-v$version-windows-x64.zip"

if (-not (Test-Path -LiteralPath (Join-Path $unpacked "RunningHub Runner.exe"))) {
  throw "RunningHub Runner.exe was not found."
}
if (-not ([System.IO.Path]::GetFullPath($archive).StartsWith([System.IO.Path]::GetFullPath($releaseRoot), [System.StringComparison]::OrdinalIgnoreCase))) {
  throw "Archive target is outside the release directory."
}

Compress-Archive -Path (Join-Path $unpacked "*") -DestinationPath $archive -CompressionLevel Optimal -Force
Write-Host "Windows package: $archive"
