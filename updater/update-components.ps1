param(
  [string]$InstallDir = $PSScriptRoot,
  [string]$ManifestUrl = 'https://github.com/WSGsety/rebuild-codex-desktop/releases/download/components-preview/update.json',
  [string]$Proxy = '',
  [switch]$CheckOnly,
  [switch]$NoLaunch,
  [switch]$AcceptUpdate,
  [string]$RequestPath = '',
  [switch]$LoadOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoPrefix = '/WSGsety/rebuild-codex-desktop/releases/download/'

function Resolve-ProgramPath([string]$Root, [string]$Relative) {
  if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains('\') -or [IO.Path]::IsPathRooted($Relative)) { throw "非法程序路径：$Relative" }
  foreach ($part in $Relative.Split('/')) {
    if (!$part -or $part -in @('.','..') -or $part -match '[. ]$' -or $part -match '[<>:"|?*\x00-\x1f]' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw "非法程序路径：$Relative" }
  }
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative.Replace('/', '\')))
  if (!$full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw '程序路径越界' }
  return $full
}

function Assert-ReleaseUrl([string]$Url) {
  $uri = [Uri]$Url
  if (!$uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com' -or !$uri.AbsolutePath.StartsWith($RepoPrefix, [StringComparison]::Ordinal) -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw '只支持本仓库 GitHub Release 的 HTTPS 下载地址' }
}

function Assert-Manifest($Manifest) {
  if ($Manifest.schemaVersion -ne 1 -or $Manifest.channel -ne 'preview' -or $Manifest.platform -ne 'win32' -or $Manifest.arch -ne 'x64') { throw '不支持此清单版本或更新渠道' }
  if ($Manifest.minimumUpdaterVersion -notmatch '^\d+\.\d+\.\d+$' -or [version]$Manifest.minimumUpdaterVersion -gt [version]'1.0.0') { throw '请先从组件预览渠道下载新版 updater-preview.zip 再检查更新' }
  if ($Manifest.buildId -notmatch '^[a-f0-9]{64}$' -or !$Manifest.files -or !$Manifest.components) { throw '清单缺少构建标识或文件信息' }
  $components = @{}
  foreach ($component in $Manifest.components) {
    if ($component.id -notin @('runtime','app','cli','tools','meta') -or $components.ContainsKey($component.id) -or $component.sha256 -notmatch '^[a-f0-9]{64}$' -or $component.name -ne ('component-'+$component.id+'-'+$component.sha256+'.zip') -or ($component.sizeBytes -isnot [int] -and $component.sizeBytes -isnot [long]) -or $component.sizeBytes -le 0 -or $component.sizeBytes -ge 2000000000) { throw '非法组件信息' }
    Assert-ReleaseUrl $component.url
    if (!([Uri]$component.url).AbsolutePath.EndsWith('/'+$component.name,[StringComparison]::Ordinal)) { throw '组件地址与文件名不一致' }
    $components[$component.id] = $component
  }
  $paths = @{}
  foreach ($file in $Manifest.files) {
    $null = Resolve-ProgramPath 'C:\component-check' $file.path
    if ($paths.ContainsKey($file.path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or ($file.sizeBytes -isnot [int] -and $file.sizeBytes -isnot [long]) -or $file.sizeBytes -lt 0 -or $file.sizeBytes -ge 2000000000 -or !$components.ContainsKey($file.component)) { throw '非法或重复的清单文件' }
    $paths[$file.path] = 'file'
  }
  foreach ($dir in $Manifest.directories) {
    $null = Resolve-ProgramPath 'C:\component-check' $dir
    if ($paths.ContainsKey($dir)) { throw '清单文件与目录冲突' }
    $paths[$dir] = 'directory'
  }
  if (!$components.ContainsKey('meta')) { throw '清单缺少更新元数据组件' }
  foreach ($name in $paths.Keys) {
    $parent = $name
    while ($parent.Contains('/')) {
      $parent = $parent.Substring(0,$parent.LastIndexOf('/'))
      if ($paths[$parent] -ne 'directory') { throw "清单缺少父目录：$parent" }
    }
  }
  $null = Resolve-ProgramPath 'C:\component-check' $Manifest.entryExecutable
  if ($paths[$Manifest.entryExecutable] -ne 'file' -or $Manifest.entryExecutable -notmatch '(?i)\.exe$') { throw '清单启动入口不正确' }
  Assert-ReleaseUrl $Manifest.full.url
  if ($Manifest.full.sha256 -notmatch '^[a-f0-9]{64}$' -or ($Manifest.full.sizeBytes -isnot [int] -and $Manifest.full.sizeBytes -isnot [long]) -or $Manifest.full.sizeBytes -le 0 -or $Manifest.full.sizeBytes -ge 2000000000) { throw '非法全量包信息' }
}

function Test-NoLink([string]$Root, [string]$File) {
  $cursor = $File
  while ($cursor.Length -ge $Root.Length) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    }
    if ($cursor -eq $Root) { break }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  return $true
}

function Test-ProgramFile([string]$Root, $File) {
  $full = Resolve-ProgramPath $Root $File.path
  if (!(Test-NoLink $Root $full)) { throw "程序路径包含链接，不能自动更新：$($File.path)" }
  if (!(Test-Path -LiteralPath $full -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $full -Force
  if ($item.Length -ne $File.sizeBytes) { return $false }
  return (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() -eq $File.sha256
}

function Get-RequiredComponents([string]$Root, $Manifest) {
  $needed = @{}
  foreach ($file in $Manifest.files) {
    if (!(Test-ProgramFile $Root $file)) { $needed[$file.component] = $true }
  }
  foreach ($dir in $Manifest.directories) {
    if (!(Test-Path -LiteralPath (Resolve-ProgramPath $Root $dir) -PathType Container)) { $needed['meta']=$true }
  }
  return @($Manifest.components | Where-Object { $needed.ContainsKey($_.id) })
}

function Get-ReleaseFile([string]$Url, [string]$Destination, [string]$ProxyUrl) {
  Assert-ReleaseUrl $Url
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $parameters = @{ Uri=$Url; OutFile=$Destination; UseBasicParsing=$true; TimeoutSec=1200; Headers=@{'User-Agent'='CodexComponentsPreviewUpdater/1'} }
  if ($ProxyUrl) { $parameters.Proxy = $ProxyUrl }
  $failure = $null
  for ($attempt=0; $attempt -lt 3; $attempt++) {
    try { Invoke-WebRequest @parameters | Out-Null; return } catch { $failure=$_; if ($attempt -lt 2) { Start-Sleep -Seconds 2 } }
  }
  throw $failure
}

function Get-VerifiedPackage($Package, [string]$Directory, [string]$ProxyUrl) {
  $file = Join-Path $Directory ($Package.sha256+'.zip')
  $partial = $file+'.part'
  if (Test-Path -LiteralPath $file) {
    if ((Get-Item -LiteralPath $file).Length -eq $Package.sizeBytes -and (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Package.sha256) { return $file }
    Remove-Item -LiteralPath $file -Force
  }
  Get-ReleaseFile $Package.url $partial $ProxyUrl
  if ((Get-Item -LiteralPath $partial).Length -ne $Package.sizeBytes -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Package.sha256) { throw "下载校验失败：$($Package.name)" }
  Move-Item -LiteralPath $partial -Destination $file
  return $file
}

function Expand-ProgramZip([string]$Zip, [string]$Destination, $Manifest, [string]$Component='') {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $expected = @{}
  foreach ($file in $Manifest.files) { if (!$Component -or $file.component -eq $Component) { $expected[$file.path]=$file } }
  $dirs = @{}
  foreach ($dir in $Manifest.directories) { $dirs[$dir]=$true }
  $seen = @{}
  $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    # 先验证整个存档，任何越界或重复条目都不能落盘。
    foreach ($entry in $archive.Entries) {
      $directory = $entry.FullName.EndsWith('/')
      $name = $entry.FullName.TrimEnd('/')
      $null = Resolve-ProgramPath $Destination $name
      if ($seen.ContainsKey($name) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'ZIP 包含重复条目或符号链接' }
      $seen[$name]=$true
      if ($directory) { if (!$dirs.ContainsKey($name)) { throw "ZIP 包含清单外目录：$name" } }
      elseif (!$expected.ContainsKey($name) -or $entry.Length -ne $expected[$name].sizeBytes) { throw "ZIP 包含清单外文件或错误大小：$name" }
    }
    foreach ($file in $expected.Keys) { if (!$seen.ContainsKey($file)) { throw "ZIP 缺少程序文件：$file" } }
    foreach ($entry in $archive.Entries) {
      $name=$entry.FullName.TrimEnd('/')
      $full=Resolve-ProgramPath $Destination $name
      if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($full) | Out-Null }
      else {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($full)) | Out-Null
        $input=$entry.Open()
        $output=[IO.File]::Open($full,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      }
    }
  } finally { $archive.Dispose() }
}

function Assert-TargetDirectory([string]$Directory, $Manifest) {
  foreach ($dir in $Manifest.directories) {
    if (!(Test-Path -LiteralPath (Resolve-ProgramPath $Directory $dir) -PathType Container)) { throw "目标缺少目录：$dir" }
  }
  foreach ($file in $Manifest.files) {
    if (!(Test-ProgramFile $Directory $file)) { throw "目标文件校验失败：$($file.path)" }
  }
}

function Switch-ProgramDirectory([string]$Original, [string]$Stage, [string]$Backup) {
  if (Test-Path -LiteralPath $Backup) { throw '备份目录已存在，拒绝覆盖' }
  $moved=$false
  try {
    [IO.Directory]::Move($Original,$Backup); $moved=$true
    [IO.Directory]::Move($Stage,$Original)
  } catch {
    if ($moved -and !(Test-Path -LiteralPath $Original)) { [IO.Directory]::Move($Backup,$Original) }
    throw
  }
}

function Invoke-ComponentUpdate($Request, [string]$Work) {
  $root=[IO.Path]::GetFullPath($Request.InstallDir).TrimEnd('\')
  $shared=@('software','program files','program files (x86)','users','downloads','desktop','documents')
  $store=Join-Path $env:ProgramFiles 'WindowsApps'
  if ([IO.Path]::GetFileName($root).ToLowerInvariant() -in $shared -or $root.StartsWith($store,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($root)) 'AppxManifest.xml'))) { throw '不能更新共享软件目录或 Microsoft Store 安装目录，请使用独立的便携程序目录' }
  if (!(Test-Path -LiteralPath (Join-Path $root 'resources\app.asar') -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $root 'resources\codex.exe') -PathType Leaf) -or (!(Test-Path -LiteralPath (Join-Path $root 'ChatGPT.exe')) -and !(Test-Path -LiteralPath (Join-Path $root 'Codex.exe'))) -or !(Test-NoLink $root $root)) { throw '请将更新工具放在本仓库便携版的程序目录中；链接目录不支持自动替换' }
  if ($Request.Proxy) {
    $proxyUri=[Uri]$Request.Proxy
    if (!$proxyUri.IsAbsoluteUri -or $proxyUri.Scheme -notin @('http','https') -or $proxyUri.UserInfo -or $proxyUri.Query -or $proxyUri.Fragment -or $proxyUri.AbsolutePath -ne '/') { throw '代理地址须为不含认证信息的 HTTP 或 HTTPS 地址' }
  }
  $lockPath=Join-Path ([IO.Path]::GetDirectoryName($root)) ('.cu-lock-'+([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant()))).Replace('-','').Substring(0,16)))
  $lock=$null
  try {
    $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $manifestPath=Join-Path $Work 'update.json'
    Write-Host '正在检查 GitHub 组件预览更新...'
    Get-ReleaseFile $Request.ManifestUrl $manifestPath $Request.Proxy
    $manifest=Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
    Assert-Manifest $manifest
    $needed=@(Get-RequiredComponents $root $manifest)
    [long]$bytes=0
    foreach ($component in $needed) { $bytes += $component.sizeBytes }
    Write-Host ("预览目标：App {0}，CLI {1}；需要 {2} 个组件，下载约 {3:N1} MB。" -f $manifest.appVersion,$manifest.codexCliVersion,$needed.Count,($bytes/1000000))
    if ($Request.CheckOnly -or !$needed.Count) { if (!$needed.Count) { Write-Host '程序文件已与此预览版一致。' }; return }
    if (!$Request.AcceptUpdate -and (Read-Host '输入 Y 下载并更新，其他输入取消') -notmatch '^(?i)y$') { return }
    [long]$targetBytes=0
    foreach ($file in $manifest.files) { $targetBytes += $file.sizeBytes }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
    if ($drive.AvailableFreeSpace -lt ($targetBytes+$manifest.full.sizeBytes+67108864)) { throw '磁盘剩余空间不足以准备更新和回滚' }
    $downloads=$root+'.component-cache'; [IO.Directory]::CreateDirectory($downloads) | Out-Null
    $stage=Join-Path $Work 'stage'; [IO.Directory]::CreateDirectory($stage) | Out-Null
    $useFull=$bytes -ge $manifest.full.sizeBytes
    if (!$useFull) {
      try {
        foreach ($component in $needed) {
          Write-Host ("下载组件：{0}" -f $component.id)
          $zip=Get-VerifiedPackage $component $downloads $Request.Proxy
          Expand-ProgramZip $zip $stage $manifest $component.id
        }
        foreach ($file in $manifest.files) {
          $destination=Resolve-ProgramPath $stage $file.path
          if (!(Test-Path -LiteralPath $destination)) {
            if (!(Test-ProgramFile $root $file)) { throw '本地文件在准备更新期间发生变化，请重新检查' }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.File]::Copy((Resolve-ProgramPath $root $file.path),$destination,$false)
          }
        }
      } catch {
        # 校验和路径异常直接终止，避免用其他包掩盖完整性错误。
        if ($_.Exception.Message -match '校验|ZIP|路径|清单|本地文件') { throw }
        Write-Host '组件暂时不可下载，将使用同一目标版本的全量包。'
        Remove-Item -LiteralPath $stage -Recurse -Force
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        $useFull=$true
      }
    }
    if ($useFull) {
      $zip=Get-VerifiedPackage $manifest.full $downloads $Request.Proxy
      Expand-ProgramZip $zip $stage $manifest
    }
    foreach ($dir in $manifest.directories) { [IO.Directory]::CreateDirectory((Resolve-ProgramPath $stage $dir)) | Out-Null }
    Assert-TargetDirectory $stage $manifest
    $active=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) })
    if ($active.Count) {
      if ($Request.AcceptUpdate) { throw '程序仍在运行，已取消替换。请完全退出后重试。' }
      $null=Read-Host '请保存工作并完全退出程序和后台进程，然后按回车继续'
      if (@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) }).Count) { throw '程序仍在运行，未进行替换' }
    }
    $backup=$root+'.backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,4)
    Switch-ProgramDirectory $root $stage $backup
    Write-Host ("预览更新完成。原目录和其中的自建文件保留在：{0}" -f $backup)
    if (!$Request.NoLaunch) {
      $arguments=@('codex://launch')
      if ($Request.Proxy) { $arguments += '--proxy-server='+$Request.Proxy }
      try { Start-Process -FilePath (Resolve-ProgramPath $root $manifest.entryExecutable) -ArgumentList $arguments -WorkingDirectory $root }
      catch { Write-Host '程序文件已更新，但未能自动启动，请从程序目录手动打开。' -ForegroundColor Yellow }
    }
    $report=[PSCustomObject]@{buildId=$manifest.buildId;sourceTag=$manifest.sourceTag;appVersion=$manifest.appVersion;codexCliVersion=$manifest.codexCliVersion;selectedComponents=@($needed|ForEach-Object{$_.id});plannedComponentBytes=$bytes;usedFull=$useFull;backupDirectory=$backup;packageCache=$downloads;completedAt=(Get-Date -Format o)}
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ($root+'.last-update.json') -Encoding UTF8
  } finally {
    if ($lock) { $lock.Dispose(); Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
  }
}

if ($LoadOnly) { return }
try {
  if (!$RequestPath) {
    $root=[IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    $work=Join-Path ([IO.Path]::GetDirectoryName($root)) ('.cu-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
    [IO.Directory]::CreateDirectory($work) | Out-Null
    $script=Join-Path $work 'update-components.ps1'
    Copy-Item -LiteralPath $PSCommandPath -Destination $script
    $request=Join-Path $work 'request.json'
    [PSCustomObject]@{InstallDir=$root;ManifestUrl=$ManifestUrl;Proxy=$Proxy;CheckOnly=[bool]$CheckOnly;NoLaunch=[bool]$NoLaunch;AcceptUpdate=[bool]$AcceptUpdate} | ConvertTo-Json | Set-Content -LiteralPath $request -Encoding UTF8
    # 临时副本独立运行，原目录中的 cmd 和 PowerShell 先退出以释放目录锁。
    Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+$script+'" -RequestPath "'+$request+'"') -WorkingDirectory $work
    exit 0
  }
  $work=$PSScriptRoot
  $request=Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Invoke-ComponentUpdate $request $work
  Set-Location ([IO.Path]::GetDirectoryName($work))
  Remove-Item -LiteralPath $work -Recurse -Force
  if (!$request.AcceptUpdate) { $null=Read-Host '按回车关闭' }
} catch {
  Write-Host ('更新未完成：'+$_.Exception.Message) -ForegroundColor Red
  Write-Host '原程序或备份仍保留；没有强制结束任何运行中的程序。'
  $null=Read-Host '按回车关闭'
  exit 1
}
