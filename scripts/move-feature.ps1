param(
  [Parameter(Mandatory)][string]$Target,   # src ki relative, e.g. features/fields
  [Parameter(Mandatory)][string[]]$Files,  # src/components lo file names, extension lekunda
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$src  = Join-Path $root 'src'
$Files = $Files | ForEach-Object { $_ -split ',' } | Where-Object { $_ }
$exts = '.jsx','.js','.tsx','.ts'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$utf8Bom   = New-Object System.Text.UTF8Encoding($true)

$moves = @{}
foreach ($n in $Files) {
  $old = $null
  foreach ($e in $exts) {
    $c = Join-Path $src "components\$n$e"
    if (Test-Path -LiteralPath $c -PathType Leaf) { $old = $c; break }
  }
  if (-not $old) { throw "Not found in src/components: $n" }
  $tdir = Join-Path $src ($Target -replace '/','\')
  $moves[$old] = Join-Path $tdir ([IO.Path]::GetFileName($old))
}

function Resolve-Import($fromDir, $spec) {
  $base = [IO.Path]::GetFullPath((Join-Path $fromDir ($spec -replace '/','\')))
  if (Test-Path -LiteralPath $base -PathType Leaf) { return @{ Path=$base; Appended=$false; Index=$false } }
  foreach ($e in $exts) {
    if (Test-Path -LiteralPath ($base+$e) -PathType Leaf) { return @{ Path=($base+$e); Appended=$true; Index=$false } }
  }
  foreach ($e in $exts) {
    $i = Join-Path $base "index$e"
    if (Test-Path -LiteralPath $i -PathType Leaf) { return @{ Path=$i; Appended=$false; Index=$true } }
  }
  return $null
}
function Get-Rel($fromDir, $toPath) {
  $f = New-Object Uri(($fromDir.TrimEnd('\') + '\'))
  $t = New-Object Uri($toPath)
  [Uri]::UnescapeDataString($f.MakeRelativeUri($t).ToString())
}

$rx = [regex]'(?<pre>\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(?<q>[''"])(?<spec>\.{1,2}/[^''"\r\n]+?)\k<q>'
$changes = @{}
$script:report = New-Object System.Collections.ArrayList

Get-ChildItem $src -Recurse -File -Include *.js,*.jsx,*.ts,*.tsx | ForEach-Object {
  $oldPath = $_.FullName
  $oldDir  = Split-Path $oldPath
  $newPath = if ($moves.ContainsKey($oldPath)) { $moves[$oldPath] } else { $oldPath }
  $newDir  = Split-Path $newPath
  $bytes   = [IO.File]::ReadAllBytes($oldPath)
  $hasBom  = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text    = [IO.File]::ReadAllText($oldPath)
  $relFile = $oldPath.Substring($root.Length + 1)

  $eval = [System.Text.RegularExpressions.MatchEvaluator]{
    param($m)
    $spec = $m.Groups['spec'].Value
    $r = Resolve-Import $oldDir $spec
    if (-not $r) { return $m.Value }
    $target = $r.Path
    if ($moves.ContainsKey($target)) { $target = $moves[$target] }
    if (($target -eq $r.Path) -and ($newDir -eq $oldDir)) { return $m.Value }
    $relp = Get-Rel $newDir $target
    if ($r.Appended) { $relp = $relp -replace '\.(jsx|js|tsx|ts)$','' }
    if ($r.Index)    { $relp = $relp -replace '/index\.[jt]sx?$',''; if (-not $relp) { $relp = '.' } }
    if ($relp -notmatch '^\.') { $relp = './' + $relp }
    if ($relp -eq $spec) { return $m.Value }
    [void]$script:report.Add(("{0}`n     {1}  ->  {2}" -f $relFile, $spec, $relp))
    return $m.Groups['pre'].Value + $m.Groups['q'].Value + $relp + $m.Groups['q'].Value
  }
  $newText = $rx.Replace($text, $eval)
  if ($newText -ne $text) { $changes[$oldPath] = @{ Text = $newText; Bom = $hasBom } }
}

"=== FILES TO MOVE ($($moves.Count)) ==="
$moves.Keys | Sort-Object | ForEach-Object { "  {0}  ->  {1}" -f $_.Substring($root.Length+1), $moves[$_].Substring($root.Length+1) }
"`n=== IMPORT REWRITES ($($script:report.Count)) in $($changes.Count) files ==="
$script:report | ForEach-Object { "  $_" }

if (-not $Apply) { "`nDRY RUN - em change avvaledu. Apply cheyyalante -Apply add cheyyi."; return }

foreach ($k in $changes.Keys) {
  $enc = if ($changes[$k].Bom) { $utf8Bom } else { $utf8NoBom }
  [IO.File]::WriteAllText($k, $changes[$k].Text, $enc)
}
New-Item -ItemType Directory -Force -Path (Join-Path $src ($Target -replace '/','\')) | Out-Null
foreach ($k in @($moves.Keys)) { git mv -- $k $moves[$k] }
"`nApplied."
