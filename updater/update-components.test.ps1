$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'update-components.ps1') -LoadOnly
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fixture=Join-Path $env:TEMP ('cu-test-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
[IO.Directory]::CreateDirectory($fixture)|Out-Null
$passed=0
function Assert-True($Value,[string]$Message) {
  if (!$Value) { throw $Message }
  $script:passed++
}
function Assert-Throws([scriptblock]$Action,[string]$Message) {
  $raised=$false
  try { & $Action | Out-Null } catch { $raised=$true }
  Assert-True $raised $Message
}
function Write-Fixture([string]$Root,[string]$Relative,[string]$Value) {
  $file=Join-Path $Root $Relative.Replace('/','\')
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))|Out-Null
  [IO.File]::WriteAllText($file,$Value,[Text.UTF8Encoding]::new($false))
}
try {
  $target=Join-Path $fixture 'target';$old=Join-Path $fixture 'old'
  $records=@(
    @('ChatGPT.exe','runtime','宿主'),
    @('resources/app.asar','app','应用'),
    @('resources/codex.exe','cli','新 CLI'),
    @('resources/中文 文件.txt','tools','工具'),
    @('build-info.json','meta','新版本信息')
  )
  $files=@()
  foreach($record in $records){
    Write-Fixture $target $record[0] $record[2]
    $file=Join-Path $target $record[0]
    $files += [PSCustomObject]@{path=$record[0];component=$record[1];sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();sizeBytes=(Get-Item -LiteralPath $file).Length}
    $value=$record[2]
    if($record[1] -in @('cli','meta')){$value='旧内容'}
    Write-Fixture $old $record[0] $value
  }
  [IO.Directory]::CreateDirectory((Join-Path $old 'resources\empty'))|Out-Null
  $components=@();$zips=@{}
  foreach($id in @('runtime','app','cli','tools','meta')){
    $group=Join-Path $fixture ('group-'+$id)
    foreach($file in @($files|Where-Object{$_.component -eq $id})){
      $destination=Join-Path $group $file.path
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))|Out-Null
      [IO.File]::Copy((Join-Path $target $file.path),$destination)
    }
    $zip=Join-Path $fixture ($id+'.zip')
    [IO.Compression.ZipFile]::CreateFromDirectory($group,$zip)
    $hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    $name='component-'+$id+'-'+$hash+'.zip'
    $components += [PSCustomObject]@{id=$id;name=$name;url=('https://github.com/WSGsety/rebuild-codex-desktop/releases/download/test/'+$name);sha256=$hash;sizeBytes=(Get-Item -LiteralPath $zip).Length}
    $zips[$id]=$zip
  }
  $manifest=[PSCustomObject]@{schemaVersion=1;minimumUpdaterVersion='1.0.0';channel='preview';platform='win32';arch='x64';buildId=('a'*64);entryExecutable='ChatGPT.exe';components=$components;files=$files;directories=@('resources','resources/empty');full=[PSCustomObject]@{url='https://github.com/WSGsety/rebuild-codex-desktop/releases/download/test/full.zip';sha256=('b'*64);sizeBytes=1}}
  Assert-Manifest $manifest
  Assert-True ((@(Get-RequiredComponents $old $manifest|ForEach-Object{$_.id}) -join ',') -eq 'cli,meta') '需要下载的组件不正确'
  foreach($bad in @('../outside','a/../b','C:/outside','a\b','NUL.txt','a/COM1','a.','a ')){
    Assert-Throws { Resolve-ProgramPath $fixture $bad } ('未拒绝非法路径：'+$bad)
  }
  Assert-Throws {Assert-ReleaseUrl 'https://example.com/file.zip'} '未拒绝第三方地址'
  $badManifest=$manifest|ConvertTo-Json -Depth 8|ConvertFrom-Json
  $badManifest.files[0].path='../escape'
  Assert-Throws {Assert-Manifest $badManifest} '未拒绝越界清单'
  $badManifest=$manifest|ConvertTo-Json -Depth 8|ConvertFrom-Json
  $badManifest.files += $badManifest.files[0]
  Assert-Throws {Assert-Manifest $badManifest} '未拒绝重复清单文件'
  $stage=Join-Path $fixture 'stage';[IO.Directory]::CreateDirectory($stage)|Out-Null
  foreach($component in $components){Expand-ProgramZip $zips[$component.id] $stage $manifest $component.id}
  foreach($dir in $manifest.directories){[IO.Directory]::CreateDirectory((Join-Path $stage $dir))|Out-Null}
  Assert-TargetDirectory $stage $manifest
  Assert-True (Test-ProgramFile $stage $files[3]) '中文和空格路径未完整解包'
  Write-Fixture $stage 'resources/codex.exe' '篡改内容'
  Assert-Throws {Assert-TargetDirectory $stage $manifest} '未发现文件损坏'
  $evil=Join-Path $fixture 'evil.zip'
  $archive=[IO.Compression.ZipFile]::Open($evil,[IO.Compression.ZipArchiveMode]::Create)
  $entry=$archive.CreateEntry('..\outside.txt');$stream=$entry.Open();$stream.WriteByte(1);$stream.Dispose();$archive.Dispose()
  Assert-Throws {Expand-ProgramZip $evil $stage $manifest 'cli'} '未拒绝 ZIP 越界'
  Assert-True (!(Test-Path -LiteralPath (Join-Path $fixture 'outside.txt'))) 'ZIP 在目标外写入了文件'
  foreach($file in $files){
    [IO.File]::Copy((Join-Path $target $file.path),(Join-Path $old $file.path),$true)
  }
  Remove-Item -LiteralPath (Join-Path $old 'resources\empty') -Recurse
  Assert-True ((@(Get-RequiredComponents $old $manifest|ForEach-Object{$_.id}) -join ',') -eq 'meta') '缺少空目录未触发修复'
  Write-Fixture $old '用户文件.txt' '用户文件'
  $missingStage=Join-Path $fixture '不存在的暂存目录';$backup=Join-Path $fixture 'backup'
  Assert-Throws {Switch-ProgramDirectory $old $missingStage $backup} '切换失败没有报错'
  Assert-True (Test-Path -LiteralPath (Join-Path $old '用户文件.txt')) '切换失败未恢复原目录'
  Assert-True (!(Test-Path -LiteralPath $backup)) '恢复后仍残留错误备份'
  Write-Fixture $stage 'resources/codex.exe' '新 CLI'
  Switch-ProgramDirectory $old $stage $backup
  Assert-TargetDirectory $old $manifest
  Assert-True (Test-Path -LiteralPath (Join-Path $backup '用户文件.txt')) '成功更新删除了用户自建文件'
  $oldPreview=[PSCustomObject]@{tag_name='preview-v26.1002.52244-cli-0.162.0';prerelease=$true;draft=$false;published_at='2026-10-09T12:00:00Z';assets=@([PSCustomObject]@{name='update.json';state='uploaded';size=1})}
  $newPreview=[PSCustomObject]@{tag_name='preview-v26.1007.21434-cli-0.162.1';prerelease=$true;draft=$false;published_at='2026-10-10T12:00:00Z';assets=$oldPreview.assets}
  $formal=[PSCustomObject]@{tag_name='v26.1008.21434-cli-0.162.1';prerelease=$false;draft=$false;published_at='2026-10-11T12:00:00Z';assets=$oldPreview.assets}
  $draft=[PSCustomObject]@{tag_name='preview-v26.1008.21434-cli-0.162.1';prerelease=$true;draft=$true;published_at='2026-10-11T12:00:00Z';assets=$oldPreview.assets}
  $missing=[PSCustomObject]@{tag_name='preview-v26.1009.21434-cli-0.162.1';prerelease=$true;draft=$false;published_at='2026-10-12T12:00:00Z';assets=@()}
  Assert-True ((Get-LatestPreviewRelease @($formal,$draft,$oldPreview,$missing,$newPreview)).tag_name -eq $newPreview.tag_name) '最新预览选择了正式版、草稿或缺少清单的版本'
  Assert-Throws {Get-ReleaseFile 'https://api.github.com/repos/other/repo/releases?per_page=100&page=1' (Join-Path $fixture 'bad.json') ''} '查询接口未限制到本仓库'
  $script:requestedUrls=@()
  function Get-ReleaseFile([string]$Url,[string]$Destination,[string]$ProxyUrl) {
    $script:requestedUrls += $Url
    if ($Url.EndsWith('page=1')) { $items=@($oldPreview)+@(1..99|ForEach-Object{$formal}) }
    elseif ($Url.EndsWith('page=2')) { $items=@($newPreview) }
    else { throw '查询了非预期页码' }
    $items | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Destination -Encoding UTF8
  }
  $found=Get-PreviewManifestUrl $fixture ''
  Assert-True ($found -eq ('https://github.com/WSGsety/rebuild-codex-desktop/releases/download/'+$newPreview.tag_name+'/update.json')) '分页查询未找到后页的最新预览'
  Assert-True ($script:requestedUrls.Count -eq 2) '查询没有按分页结束'
  $badRequest=Join-Path $fixture 'unattended-request.json'
  [PSCustomObject]@{InstallDir=(Join-Path $fixture 'no-program');ManifestUrl='';Proxy='';CheckOnly=$false;NoLaunch=$true;AcceptUpdate=$true} | ConvertTo-Json | Set-Content -LiteralPath $badRequest -Encoding UTF8
  $stdout=Join-Path $fixture 'unattended-output.txt';$stderr=Join-Path $fixture 'unattended-error.txt'
  $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'update-components.ps1')+'" -RequestPath "'+$badRequest+'"'
  $child=Start-Process powershell.exe -ArgumentList $arguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (!$child.WaitForExit(10000)) { Stop-Process -Id $child.Id -Force; throw '无人值守失败仍在等待输入' }
  Assert-True ($child.ExitCode -ne 0) '无效安装目录没有返回失败'
  $errors=Get-Content -Raw -LiteralPath $stderr
  Assert-True (!$errors -or $errors -notmatch 'Read-Host|NonInteractive') '无人值守失败触发了控制台输入异常'
  Write-Output ("PowerShell 基础检查通过："+$passed+" 个断言；没有安装或运行桌面应用。")
} finally {
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
