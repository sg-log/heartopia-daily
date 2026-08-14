param(
  [switch]$WriteDataJs
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$puzzleDir = Join-Path $root "assets/puzzles"
$imageDir = Join-Path $puzzleDir "images"
$jsonPath = Join-Path $puzzleDir "puzzles.json"
$dataJsPath = Join-Path $puzzleDir "puzzles-data.js"

function Read-PuzzleDataJs {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing puzzles-data.js: $Path"
  }

  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  $prefixPattern = '^\s*window\.HEARTOPIA_PUZZLES\s*=\s*'
  $jsonText = ($raw -replace $prefixPattern, '') -replace ';\s*$', ''
  return $jsonText | ConvertFrom-Json
}

function Get-ExpectedImagePath {
  param([object]$Puzzle)
  return "assets/puzzles/images/$($Puzzle.id).webp"
}

if (-not (Test-Path -LiteralPath $jsonPath)) {
  throw "Missing puzzles.json: $jsonPath"
}

$puzzles = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($puzzles.Count -ne 110) {
  throw "puzzles.json must contain 110 items, got $($puzzles.Count)."
}

$seenIds = @{}
$seenOrders = @{}
$errors = New-Object System.Collections.Generic.List[string]

for ($i = 0; $i -lt $puzzles.Count; $i++) {
  $puzzle = $puzzles[$i]
  $expectedOrder = $i + 1
  $expectedId = "puzzle-{0:D3}" -f $expectedOrder
  $expectedImage = Get-ExpectedImagePath $puzzle

  if ([string]::IsNullOrWhiteSpace($puzzle.id)) {
    [void]$errors.Add("Item $expectedOrder has an empty id.")
  } elseif ($puzzle.id -ne $expectedId) {
    [void]$errors.Add("Item $expectedOrder id must be $expectedId, got $($puzzle.id).")
  }

  if ([string]::IsNullOrWhiteSpace($puzzle.name)) {
    [void]$errors.Add("$($puzzle.id) has an empty name.")
  }

  if ([int]$puzzle.order -ne $expectedOrder) {
    [void]$errors.Add("$($puzzle.id) order must be $expectedOrder, got $($puzzle.order).")
  }

  if ($puzzle.image -ne $expectedImage) {
    [void]$errors.Add("$($puzzle.id) image must be $expectedImage, got $($puzzle.image).")
  }

  if ($seenIds.ContainsKey($puzzle.id)) {
    [void]$errors.Add("Duplicate id: $($puzzle.id).")
  } else {
    $seenIds[$puzzle.id] = $true
  }

  if ($seenOrders.ContainsKey([int]$puzzle.order)) {
    [void]$errors.Add("Duplicate order: $($puzzle.order).")
  } else {
    $seenOrders[[int]$puzzle.order] = $true
  }

  $imagePath = Join-Path $root $puzzle.image
  if (-not (Test-Path -LiteralPath $imagePath)) {
    [void]$errors.Add("Missing image for $($puzzle.id): $($puzzle.image).")
  }
}

$imageFiles = @(Get-ChildItem -LiteralPath $imageDir -Filter "puzzle-*.webp" -File -ErrorAction Stop)
if ($imageFiles.Count -ne 110) {
  [void]$errors.Add("assets/puzzles/images must contain 110 puzzle WebP files, got $($imageFiles.Count).")
}

$expectedNames = @{}
foreach ($puzzle in $puzzles) {
  $expectedNames["$($puzzle.id).webp"] = $true
}
foreach ($file in $imageFiles) {
  if (-not $expectedNames.ContainsKey($file.Name)) {
    [void]$errors.Add("Unexpected puzzle image file: $($file.Name).")
  }
}

if ($WriteDataJs) {
  $puzzlesJson = $puzzles | ConvertTo-Json -Depth 5
  $dataJs = "window.HEARTOPIA_PUZZLES = $puzzlesJson;`n"
  Set-Content -LiteralPath $dataJsPath -Value $dataJs -Encoding UTF8
}

$dataPuzzles = Read-PuzzleDataJs -Path $dataJsPath
if ($dataPuzzles.Count -ne $puzzles.Count) {
  [void]$errors.Add("puzzles-data.js must contain $($puzzles.Count) items, got $($dataPuzzles.Count).")
} else {
  for ($i = 0; $i -lt $puzzles.Count; $i++) {
    $jsonPuzzle = $puzzles[$i]
    $dataPuzzle = $dataPuzzles[$i]
    foreach ($field in @("id", "name", "image", "order")) {
      if ("$($jsonPuzzle.$field)" -ne "$($dataPuzzle.$field)") {
        [void]$errors.Add("puzzles-data.js mismatch at index $i field ${field}: json=$($jsonPuzzle.$field), js=$($dataPuzzle.$field).")
      }
    }
  }
}

if ($errors.Count) {
  $errors | ForEach-Object { Write-Error $_ }
  throw "Puzzle data validation failed with $($errors.Count) error(s)."
}

Write-Host "Puzzle data validation passed."
Write-Host "puzzles.json: $($puzzles.Count) items"
Write-Host "puzzles-data.js: $($dataPuzzles.Count) items"
Write-Host "images: $($imageFiles.Count) WebP files"
if ($WriteDataJs) {
  Write-Host "puzzles-data.js was regenerated from puzzles.json."
} else {
  Write-Host "No files were written. Use -WriteDataJs to regenerate puzzles-data.js only."
}
