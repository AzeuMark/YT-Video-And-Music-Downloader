@echo off
REM FetchTube launcher - one window only. Installs deps if needed,
REM starts the server in this same window, opens the browser, then minimizes.
title FetchTube
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [FetchTube] Node.js was not found.
  echo Please install it from https://nodejs.org, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [FetchTube] First run: installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo [FetchTube] Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo [FetchTube] Starting server in this window...
start /b "" node server.js

echo [FetchTube] Waiting for the server, then opening the browser...
timeout /t 5 /nobreak >nul
start "" "http://localhost:3000"

echo.
echo [FetchTube] Running at http://localhost:3000
echo This window will minimize - close it any time to stop FetchTube.
powershell -noprofile -command "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);' -Name WinUtil -Namespace WinUtil; $ppid = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId; $h = (Get-Process -Id $ppid -ErrorAction SilentlyContinue).MainWindowHandle; [WinUtil.WinUtil]::ShowWindowAsync($h, 6) > $null" 2>nul
pause >nul
