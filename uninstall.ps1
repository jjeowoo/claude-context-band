# Removes this folder from env.CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json.
$ErrorActionPreference = 'Stop'

$settingsPath = Join-Path $HOME '.claude\settings.json'
if (-not (Test-Path $settingsPath)) { Write-Host '설정 파일이 없습니다.'; exit 0 }

$settings = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ($settings.PSObject.Properties['env'] -and $settings.env.PSObject.Properties['CLAUDE_CODE_PLUGIN_DIRS'])) {
    Write-Host '등록되어 있지 않습니다.'; exit 0
}
Copy-Item $settingsPath "$settingsPath.bak" -Force

$dirs = @($settings.env.CLAUDE_CODE_PLUGIN_DIRS -split ';' | Where-Object { $_ -and ((Split-Path $_ -Leaf) -notin @('context-band', 'claude-context-band')) })
if ($dirs.Count -eq 0) {
    $settings.env.PSObject.Properties.Remove('CLAUDE_CODE_PLUGIN_DIRS')
} else {
    $settings.env.CLAUDE_CODE_PLUGIN_DIRS = $dirs -join ';'
}

$json = $settings | ConvertTo-Json -Depth 32
[System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding $false))

Write-Host 'context-band 등록 해제 완료. 새 세션부터 적용됩니다.'
