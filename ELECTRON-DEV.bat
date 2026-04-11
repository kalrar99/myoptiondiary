@echo off
title MyOptionDiary — Electron Dev
color 0A

set "TRADE=%~dp0trade-tracker"

echo.
echo  ============================================
echo   MyOptionDiary — Local Electron Dev Test
echo  ============================================
echo.
echo  Builds React, then opens the Electron window.
echo  Use this to test the packaged layout without
echo  building a full .exe installer.
echo.
echo  Press Ctrl+C at any time to quit.
echo.

pushd "%TRADE%"

:: ── Step 1: Install dependencies ──────────────────────────
echo  [1/3] Installing dependencies...
call npm install --legacy-peer-deps
if %errorlevel% neq 0 (
    echo  [ERROR] npm install failed.
    popd
    pause
    exit /b 1
)
echo  [OK] Dependencies ready
echo.

:: ── NOTE: No electron-rebuild needed ──────────────────────
:: The app uses sql.js (pure JavaScript WASM), NOT better-sqlite3.
:: sql.js requires zero native compilation — no electron-rebuild step.
:: Removing the old 'electron-rebuild -f -w better-sqlite3' line
:: which would fail because better-sqlite3 is not installed.

:: ── Step 2: Build React ────────────────────────────────────
echo  [2/3] Building React app...
echo.
echo  Frontend modules bundled by webpack into build/static/js/:
echo    src/api/demoEngine.js     (demo data engine - isolated from live)
echo    src/utils/tradingCalendar.js (holiday engine + risk-free rate)
echo    src/utils/yahooQuotes.js  (Yahoo Finance price fetcher)
echo    src/components/*.jsx      (all UI components)
echo    src/App.jsx               (routing, state, live + demo handlers)
echo.
echo  The backend (trade-tracker-backend.js) is NOT part of the React
echo  bundle — it runs as a separate Node.js process.
echo.
set GENERATE_SOURCEMAP=false
set DISABLE_ESLINT_PLUGIN=true
set NODE_OPTIONS=--openssl-legacy-provider
call npm run react:build
if %errorlevel% neq 0 (
    echo  [ERROR] React build failed. Check the output above for errors.
    popd
    pause
    exit /b 1
)
echo  [OK] React build complete
echo.

:: ── Step 3: Launch Electron ────────────────────────────────
echo  [3/3] Launching Electron window...
echo  The backend will start at http://127.0.0.1:3002
echo  (using system Node.js in dev mode)
echo.
call npx electron .

popd
