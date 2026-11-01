$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$target = Join-Path $root 'download-engine'
$uri = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip'
$expected = '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288'
$cache = Join-Path $root 'tmp/aria2'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$archive = Join-Path $cache 'official.zip'
function Get-Digest([string] $file) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($file)
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
if (!(Test-Path -LiteralPath $archive) -or (Get-Digest $archive) -ne $expected) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $client = New-Object System.Net.WebClient
  try { $client.DownloadFile($uri, $archive) } finally { $client.Dispose() }
}
if ((Get-Digest $archive) -ne $expected) { throw 'aria2 archive checksum mismatch' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Force -Path $target | Out-Null
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  foreach ($name in @('aria2c.exe', 'COPYING', 'AUTHORS', 'LICENSE.OpenSSL', 'README.mingw')) {
    $entry = $zip.GetEntry("aria2-1.37.0-win-64bit-build1/$name")
    if (!$entry) { throw "Missing aria2 resource: $name" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $target $name), $true)
  }
} finally { $zip.Dispose() }
$sourceArchive = Join-Path $cache 'aria2-1.37.0.tar.xz'
$sourceHash = '60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b'
if (!(Test-Path -LiteralPath $sourceArchive) -or (Get-Digest $sourceArchive) -ne $sourceHash) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $client = New-Object System.Net.WebClient
  try { $client.DownloadFile('https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.xz', $sourceArchive) } finally { $client.Dispose() }
}
if ((Get-Digest $sourceArchive) -ne $sourceHash) { throw 'aria2 source checksum mismatch' }
Copy-Item -LiteralPath $sourceArchive -Destination (Join-Path $target 'aria2-1.37.0.tar.xz') -Force
Write-Output 'Official aria2 1.37.0 prepared and SHA-256 verified.'
