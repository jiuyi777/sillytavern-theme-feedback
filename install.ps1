[CmdletBinding()]
param(
    [string]$SillyTavernRoot = 'D:\SillyTavern',
    [string]$UserProfileName = 'default-user',
    [string]$AllowedUserHandle = $UserProfileName,
    [string]$FeedbackRoot = "$env:USERPROFILE\Documents\酒馆美化\手机反馈",
    [switch]$EnableServerPlugins
)

$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$stRoot = (Resolve-Path -LiteralPath $SillyTavernRoot).Path
$manifestPath = Join-Path $sourceRoot 'manifest.json'
$serverSource = Join-Path $sourceRoot 'server'
$configPath = Join-Path $stRoot 'config.yaml'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "找不到前端扩展 manifest.json：$manifestPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $serverSource 'index.js') -PathType Leaf)) {
    throw "找不到服务端插件：$serverSource"
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "目标不是有效的 SillyTavern 目录：$stRoot"
}

$frontendTarget = Join-Path $stRoot "data\$UserProfileName\extensions\theme-feedback-assistant"
$serverTarget = Join-Path $stRoot 'plugins\theme-feedback'
New-Item -ItemType Directory -Path $frontendTarget -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $frontendTarget 'vendor') -Force | Out-Null
New-Item -ItemType Directory -Path $serverTarget -Force | Out-Null

foreach ($file in @('manifest.json', 'index.js', 'style.css', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $frontendTarget $file) -Force
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'vendor\html2canvas.esm.js') -Destination (Join-Path $frontendTarget 'vendor\html2canvas.esm.js') -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'vendor\html2canvas.LICENSE') -Destination (Join-Path $frontendTarget 'vendor\html2canvas.LICENSE') -Force
foreach ($file in @('package.json', 'index.js')) {
    Copy-Item -LiteralPath (Join-Path $serverSource $file) -Destination (Join-Path $serverTarget $file) -Force
}

$feedbackPath = [IO.Path]::GetFullPath($FeedbackRoot)
New-Item -ItemType Directory -Path $feedbackPath -Force | Out-Null
@{
    feedbackRoot = $feedbackPath
    maxImageBytes = 15728640
    allowedUserHandles = @($AllowedUserHandle)
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $serverTarget 'config.local.json') -Encoding UTF8

$serverPluginsEnabled = Select-String -LiteralPath $configPath -Pattern '^enableServerPlugins:\s*true\s*$' -Quiet
if ($EnableServerPlugins -and -not $serverPluginsEnabled) {
    $configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    if ($configText -notmatch '(?m)^enableServerPlugins:\s*false\s*$') {
        throw '无法安全定位 config.yaml 中的 enableServerPlugins: false。'
    }
    $configText = $configText -replace '(?m)^enableServerPlugins:\s*false\s*$', 'enableServerPlugins: true'
    Set-Content -LiteralPath $configPath -Value $configText -Encoding UTF8
    $serverPluginsEnabled = $true
}

[pscustomobject]@{
    FrontendExtension = $frontendTarget
    ServerPlugin = $serverTarget
    FeedbackInbox = $feedbackPath
    AllowedUserHandle = $AllowedUserHandle
    ServerPluginsEnabled = $serverPluginsEnabled
    RestartRequired = $true
} | Format-List

if (-not $serverPluginsEnabled) {
    Write-Warning '服务端插件仍处于关闭状态。确认安装后，请使用 -EnableServerPlugins 再运行一次。'
}
