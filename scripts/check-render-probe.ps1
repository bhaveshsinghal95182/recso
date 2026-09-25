param(
  [Parameter(Mandatory = $true)]
  [string] $ProjectFolder,

  [Parameter(Mandatory = $true)]
  [string] $ExportVideo,

  [double] $StartSeconds = 240,
  [int] $FrameCount = 180,
  [string] $Ffmpeg = 'ffmpeg'
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectFolder).Path
$export = (Resolve-Path -LiteralPath $ExportVideo).Path
$source = Get-ChildItem -LiteralPath $project -Filter '*.mp4' -File |
  Where-Object { $_.FullName -ne $export } |
  Select-Object -First 1
$dump = Join-Path $project '.recso\render-dump'

if (-not $source) { throw "No source MP4 found under $project" }
if (-not (Test-Path -LiteralPath $dump)) { throw "Render dump not found: $dump" }

function Get-VideoHashes([string] $path, [string] $name) {
  $md5 = Join-Path $env:TEMP "recso-$name-$([guid]::NewGuid()).framemd5"
  & $Ffmpeg -v error -ss $StartSeconds -i $path -frames:v $FrameCount `
    -vf 'crop=160:36:490:342,format=gray' -an -f framemd5 $md5
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed for $path" }
  try {
    return @(Get-Content -LiteralPath $md5 |
      Where-Object { $_ -match '^\s*0,' } |
      ForEach-Object { ($_ -split ',')[-1].Trim() })
  } finally {
    Remove-Item -LiteralPath $md5 -Force -ErrorAction SilentlyContinue
  }
}

function Get-PpmHashes {
  return @(Get-ChildItem -LiteralPath $dump -Filter '*.ppm' -File |
    Sort-Object Name |
    ForEach-Object {
      $lines = certutil -hashfile $_.FullName MD5
      ($lines | Where-Object { $_ -match '^[0-9a-fA-F]{32}$' }).Trim()
    })
}

function Get-Stats([string[]] $hashes) {
  $same = 0
  for ($i = 1; $i -lt $hashes.Count; $i++) {
    if ($hashes[$i] -eq $hashes[$i - 1]) { $same++ }
  }
  [pscustomobject]@{
    frames = $hashes.Count
    unique_frames = @($hashes | Sort-Object -Unique).Count
    changed_frames = [math]::Max(0, $hashes.Count - 1 - $same)
    consecutive_duplicate_pairs = $same
    consecutive_duplicate_rate = [math]::Round($same / [math]::Max(1, $hashes.Count - 1), 4)
  }
}

$sourceHashes = Get-VideoHashes $source.FullName 'source'
$exportHashes = Get-VideoHashes $export 'export'
$renderHashes = Get-PpmHashes

Write-Host "Source: $($source.FullName)"
Write-Host "Export: $export"
Write-Host "Render dump: $dump"
Write-Host "Window: $StartSeconds seconds, $FrameCount frames"
Write-Host ''
Write-Host 'SOURCE'
Get-Stats $sourceHashes | Format-List
Write-Host 'PRE_ENCODER_RENDER'
Get-Stats $renderHashes | Format-List
Write-Host 'EXPORT'
Get-Stats $exportHashes | Format-List

$n = [math]::Min($sourceHashes.Count, $exportHashes.Count)
$different = 0
for ($i = 0; $i -lt $n; $i++) {
  if ($sourceHashes[$i] -ne $exportHashes[$i]) { $different++ }
}
Write-Host 'SOURCE_EXPORT_ALIGNMENT'
[pscustomobject]@{
  compared_frames = $n
  different_hashes = $different
  different_rate = [math]::Round($different / [math]::Max(1, $n), 4)
} | Format-List

Write-Host 'INTERPRETATION'
if ((Get-Stats $renderHashes).unique_frames -gt (Get-Stats $sourceHashes).unique_frames) {
  Write-Host 'Pre-encoder render is changing more than the source: investigate render/compositing/NV12 input.'
} else {
  Write-Host 'Pre-encoder render does not add extra changes relative to the source.'
}
if ((Get-Stats $exportHashes).unique_frames -gt (Get-Stats $renderHashes).unique_frames) {
  Write-Host 'Export adds further changes: investigate encoder or encoder input conversion.'
} else {
  Write-Host 'Export does not add more unique timer images than the render dump.'
}
