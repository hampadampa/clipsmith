@echo off
rem Dubbelklicka for att starta Clipsmith. Forsta gangen hamtar den det som behovs (nagra minuter, kraver internet).
setlocal
cd /d "%~dp0"
title Clipsmith

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js behovs for att starta programmet fran kallkod och saknas pa datorn.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo Hittade inte Windows pakethanterare ^(winget^). Installera Node.js ^(LTS^) fran nodejs.org och dubbelklicka sedan pa den har filen igen.
    start "" "https://nodejs.org/en/download"
    pause
    exit /b 1
  )
  echo Installerar Node.js med winget. Windows kan fraga om tillstand.
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js ar installerat men hittas inte an. Stang det har fonstret och dubbelklicka pa filen igen.
    pause
    exit /b 1
  )
)

if not exist node_modules (
  echo Forsta starten: hamtar programmets delar. Det tar nagra minuter, stang inte fonstret.
  call npm install
  if errorlevel 1 (
    echo.
    echo Installationen misslyckades. Ta en bild pa felet ovan och skicka den.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 (
  echo.
  echo Programmet avslutades med ett fel. Ta en bild pa texten ovan och skicka den.
  pause
)
