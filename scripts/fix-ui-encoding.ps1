$files = @(
  ".\src\components\MapPreviewCard.jsx",
  ".\src\components\FullMapModal.jsx"
)

foreach ($file in $files) {
  $text = Get-Content $file -Raw

  if ($file -like "*FullMapModal.jsx") {

    # Language labels: keep source ASCII-safe using Unicode escapes
    $text = [regex]::Replace(
      $text,
      "\{\s*code:\s*'te-IN',\s*label:.*?\},",
      "{ code: 'te-IN', label: '\u0C24\u0C46\u0C32\u0C41\u0C17\u0C41' },"
    )

    $text = [regex]::Replace(
      $text,
      "\{\s*code:\s*'hi-IN',\s*label:.*?\},",
      "{ code: 'hi-IN', label: '\u0939\u093F\u0928\u094D\u0926\u0940' },"
    )

    # Search header - remove corrupted emoji completely
    $text = [regex]::Replace(
      $text,
      'placeholder="[^"]*Search location[^"]*"',
      'placeholder="Search location..."'
    )

    # Common corrupted microphone UI -> simple text
    $text = [regex]::Replace(
      $text,
      "\{listening \? '[^']*' : '[^']*'\}",
      "{listening ? 'Listening...' : 'Voice'}"
    )
  }

  if ($file -like "*MapPreviewCard.jsx") {

    # Replace corrupted loading character with ASCII-safe text
    $text = $text.Replace(
      "{loading ? 'â€¦' : cattleList.length}",
      "{loading ? '...' : cattleList.length}"
    )

    # Share button: ASCII-safe fallback
    $text = $text.Replace(
      "{sharing ? '…' : '📤'}",
      "{sharing ? '...' : 'Share'}"
    )

    # Remove corrupted emoji from comments only where practical
    $text = $text.Replace("ðŸ  marker", "home marker")
    $text = $text.Replace("ðŸ  per distinct base", "home marker per distinct base")
  }

  # IMPORTANT: write as UTF-8
  Set-Content -Path $file -Value $text -Encoding utf8
}

Write-Host "`nEncoding/UI cleanup completed." -ForegroundColor Green
