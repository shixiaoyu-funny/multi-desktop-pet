<#
    把本仓库的 DSH 插件（代码 + 动作素材）同步到 DSH 的本地插件目录。

    唯一真源
      · 插件代码：<仓库>\dsh-plugin\
      · 动作素材：<仓库>\src\assets\   （视频 + manifest.json）

    同步目标
      · 默认 C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\role2-pet-plugin
        —— 也就是 DSH profile 里 `link:` 指向的那份

    只做三件事：内容不同的文件覆盖、目标多出来的素材删除、最后打印一份清单。
    加 -CheckOnly 只看差异不动手（有漂移时退出码 1）。

    兼容 Windows PowerShell 5.1（本机没有 pwsh）。
#>
[CmdletBinding()]
param(
    [string]$Target = 'C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\role2-pet-plugin',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot
$pluginSrc = Join-Path $root 'dsh-plugin'
$assetsSrc = Join-Path $root 'src\assets'

# ——— 前置校验：源齐、目标像那么回事，避免把文件撒到错地方 ———
if (-not (Test-Path (Join-Path $assetsSrc 'manifest.json'))) {
    throw "找不到动作清单：$assetsSrc\manifest.json"
}
if (-not (Test-Path (Join-Path $pluginSrc 'index.js'))) {
    throw "找不到插件入口：$pluginSrc\index.js"
}
if (-not (Test-Path $Target)) {
    throw "目标目录不存在：$Target`n（先把插件装好，或手动改成实际路径）"
}
$targetPkg = Join-Path $Target 'package.json'
if (-not (Test-Path $targetPkg) -or -not ((Get-Content $targetPkg -Raw) -match 'role2-pet')) {
    throw "目标目录不像 role2 插件目录（package.json 里没有 role2-pet）：$Target"
}

function Get-RelPath([string]$Base, [string]$Full) {
    $prefix = $Base.TrimEnd('\') + '\'
    if ($Full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Full.Substring($prefix.Length)
    }
    throw "无法计算相对路径：$Full （基准 $Base）"
}

function Get-Hash([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

$copied  = New-Object System.Collections.Generic.List[string]
$same    = 0
$removed = New-Object System.Collections.Generic.List[string]

function Copy-IfChanged([string]$Src, [string]$Dst, [string]$Label) {
    $dir = Split-Path -Parent $Dst
    if (-not (Test-Path $dir) -and -not $CheckOnly) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    if ((Test-Path $Dst) -and ((Get-Hash $Src) -eq (Get-Hash $Dst))) {
        $script:same++
        return
    }
    if (-not $CheckOnly) {
        Copy-Item -LiteralPath $Src -Destination $Dst -Force
    }
    $script:copied.Add($Label)
}

# ——— 1. 插件代码 ———
$codeFiles = @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md')
$localeDir = Join-Path $pluginSrc 'locale'
if (Test-Path $localeDir) {
    $codeFiles += (Get-ChildItem -LiteralPath $localeDir -Filter *.json | ForEach-Object { "locale\$($_.Name)" })
}
foreach ($rel in $codeFiles) {
    $src = Join-Path $pluginSrc $rel
    if (-not (Test-Path $src)) { continue }
    Copy-IfChanged $src (Join-Path $Target $rel) $rel
}

# ——— 2. 动作素材（完全镜像：源里没有的，目标里的也删掉）———
$assetsDst = Join-Path $Target 'assets'
if (-not (Test-Path $assetsDst) -and -not $CheckOnly) {
    New-Item -ItemType Directory -Path $assetsDst -Force | Out-Null
}

$sourceSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($file in (Get-ChildItem -LiteralPath $assetsSrc -Recurse -File)) {
    $rel = (Get-RelPath $assetsSrc $file.FullName).Replace('\', '/')
    [void]$sourceSet.Add($rel)
    Copy-IfChanged $file.FullName (Join-Path $assetsDst $rel.Replace('/', '\')) ("assets/" + $rel)
}

if (Test-Path $assetsDst) {
    foreach ($file in (Get-ChildItem -LiteralPath $assetsDst -Recurse -File)) {
        $rel = (Get-RelPath $assetsDst $file.FullName).Replace('\', '/')
        if (-not $sourceSet.Contains($rel)) {
            if (-not $CheckOnly) { Remove-Item -LiteralPath $file.FullName -Force }
            $removed.Add("assets/" + $rel)
        }
    }
    # 顺手清掉清空后遗留的空目录
    if (-not $CheckOnly) {
        Get-ChildItem -LiteralPath $assetsDst -Recurse -Directory |
            Sort-Object { $_.FullName.Length } -Descending |
            Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
}

# ——— 3. 清单 ———
$mode = if ($CheckOnly) { '检查模式（未改动任何文件）' } else { '同步完成' }
Write-Host ""
Write-Host "[$mode]" -ForegroundColor Cyan
Write-Host ("  目标      {0}" -f $Target)
Write-Host ("  未变      {0} 个文件" -f $same)
if ($copied.Count -eq 0) {
    Write-Host "  已更新    无" -ForegroundColor Green
} else {
    Write-Host ("  已更新    {0} 个文件" -f $copied.Count) -ForegroundColor Yellow
    $copied | ForEach-Object { Write-Host "            $_" -ForegroundColor DarkGray }
}
if ($removed.Count -gt 0) {
    Write-Host ("  已删除    {0} 个多余素材" -f $removed.Count) -ForegroundColor Yellow
    $removed | ForEach-Object { Write-Host "            $_" -ForegroundColor DarkGray }
}

if ($CheckOnly -and ($copied.Count -gt 0 -or $removed.Count -gt 0)) {
    Write-Host ""
    Write-Host "存在漂移：去掉 -CheckOnly 重新运行即可对齐。" -ForegroundColor Yellow
    exit 1
}

if (-not $CheckOnly -and $copied.Count -gt 0) {
    Write-Host ""
    Write-Host "插件代码改动会被 DSH 热重载；素材改动刷新页面即可生效。" -ForegroundColor DarkGray
}
Write-Host ""
