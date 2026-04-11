@echo off
title Options Tracker v5 — License Manager
color 0A

cd /d "%~dp0"

echo.
echo  OPTIONS TRACKER v5 — LICENSE MANAGER
echo  =====================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules\better-sqlite3" (
    echo  Installing dependencies...
    call npm install
)

echo  Commands:
echo    list              — Show all license keys
echo    generate Lifetime user@email.com   — Generate a Lifetime key
echo    generate Annual   user@email.com 2025-12-31  — Generate Annual key
echo    disable XXXX-XXXX-XXXX-XXXX       — Disable a key
echo.
set /p CMD=Enter command: 

node generate-license.js %CMD%

echo.
echo  Exporting licenses to offline fallback...
node export-licenses.js

echo.
pause
