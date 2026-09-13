param(
  [Parameter(Mandatory = $true)]
  [string] $ProjectFolder,
  [string] $Ffmpeg = 'ffmpeg'
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectFolder).Path
$dump = Join-Path (Join-Path $project '.recso') 'render-dump'
$pattern = Join-Path $dump 'frame_%06d.ppm'
if (-not (Test-Path -LiteralPath $dump)) {
  throw "Render dump not found under $project"
}

$lines = @(& $Ffmpeg -v error -framerate 60 -i $pattern `
  -vf 'signalstats,metadata=print' -an -f null - 2>&1)
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg failed while reading the render dump' }

$ydif = @($lines | Select-String 'lavfi.signalstats.YDIF=' | ForEach-Object {
  [double](($_.Line -split '=')[-1])
})
if ($ydif.Count -lt 2) { throw 'No frame-difference metrics were produced' }

$changes = $ydif | Select-Object -Skip 1
$mean = ($changes | Measure-Object -Average).Average
$max = ($changes | Measure-Object -Maximum).Maximum
$sorted = @($changes | Sort-Object)
$p95 = $sorted[[math]::Min($sorted.Count - 1, [math]::Floor($sorted.Count * 0.95))]
$abrupt = @($changes | Where-Object { $_ -gt ($mean * 3) -and $_ -gt 1.0 }).Count

[pscustomobject]@{
  frames = $ydif.Count
  transitions = $changes.Count
  mean_luma_difference = [math]::Round($mean, 3)
  p95_luma_difference = [math]::Round($p95, 3)
  max_luma_difference = [math]::Round($max, 3)
  abrupt_transitions = $abrupt
} | Format-List

if ($abrupt -gt 0) {
  Write-Host 'RESULT: pre-encoder render contains abrupt pixel changes.'
  exit 1
}

Write-Host 'RESULT: no abrupt pre-encoder render changes detected.'
