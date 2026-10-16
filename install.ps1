# Registers this folder in ~/.claude/settings.json (env.CLAUDE_CODE_PLUGIN_DIRS)
# so every new Claude Code session, including the desktop app's Code tab, loads the mod.
$ErrorActionPreference = 'Stop'

$modDir = $PSScriptRoot
$settingsPath = Join-Path $HOME '.claude\settings.json'

if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Copy-Item $settingsPath "$settingsPath.bak" -Force
} else {
    New-Item -ItemType Directory -Force (Split-Path $settingsPath) | Out-Null
    $settings = [pscustomobject]@{}
}

if (-not $settings.PSObject.Properties['env']) {
    $settings | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{})
}

$current = ''
if ($settings.env.PSObject.Properties['CLAUDE_CODE_PLUGIN_DIRS']) {
    $current = $settings.env.CLAUDE_CODE_PLUGIN_DIRS
}

# Drop any earlier context-band entry, keep every other plugin folder.
$dirs = @($current -split ';' | Where-Object { $_ -and ((Split-Path $_ -Leaf) -notin @('context-band', 'claude-context-band')) })
$dirs += $modDir
$settings.env | Add-Member -NotePropertyName CLAUDE_CODE_PLUGIN_DIRS -NotePropertyValue ($dirs -join ';') -Force

$json = $settings | ConvertTo-Json -Depth 32
[System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding $false))

Write-Host "context-band 등록 완료: $modDir"
Write-Host "Claude 앱을 껐다 켜거나 새 세션을 열면 적용됩니다."
