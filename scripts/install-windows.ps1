# Installs or reinstalls MoonerADE from the latest GitHub release into %LOCALAPPDATA%\Programs\MoonerADE:
#   irm https://raw.githubusercontent.com/Mooner510/mooner-ade/master/scripts/install-windows.ps1 | iex
# No admin rights: the folder is per-user and writable, which the in-app updater needs. Adds Start menu and desktop shortcuts.
# Runs in its own scope so the pasted command leaves no variables or preferences behind in the user's session.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1 downloads many times slower while drawing the progress bar.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $name = 'MoonerADE-win32-x64'
  $dest = Join-Path $env:LOCALAPPDATA 'Programs\MoonerADE'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "mooner-ade-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Path "$tmp\out" | Out-Null
  try {
    Write-Host "MoonerADE 다운로드 중..."
    try { Invoke-WebRequest -UseBasicParsing "https://github.com/Mooner510/mooner-ade/releases/latest/download/$name.zip" -OutFile "$tmp\app.zip" }
    catch { throw "최신 릴리스에서 $name.zip을 받지 못했습니다: $($_.Exception.Message)" }
    & "$env:SystemRoot\System32\tar.exe" -xf "$tmp\app.zip" -C "$tmp\out"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$tmp\out\$name\MoonerADE.exe")) { throw '압축 파일 구성이 올바르지 않습니다.' }

    # Close a running copy (and the bundled node.exe it started) so its files can be replaced.
    $running = { Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith("$dest\", 'OrdinalIgnoreCase') } }
    if (& $running) {
      Write-Host '실행 중인 MoonerADE를 종료합니다...'
      & $running | ForEach-Object { [void]$_.CloseMainWindow() }
      for ($i = 0; $i -lt 20 -and (& $running); $i++) { Start-Sleep -Milliseconds 500 }
      & $running | Stop-Process -Force
      Start-Sleep -Milliseconds 500
    }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Move-Item "$tmp\out\$name" $dest
    Get-ChildItem $dest -Recurse -File | Unblock-File

    $exe = Join-Path $dest 'MoonerADE.exe'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
      $link = $shell.CreateShortcut((Join-Path $folder 'MoonerADE.lnk'))
      $link.TargetPath = $exe
      $link.WorkingDirectory = $dest
      $link.Save()
    }
    Write-Host "설치 완료: $exe (시작 메뉴·바탕 화면 바로 가기 추가)"
    Start-Process $exe
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
