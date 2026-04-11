@echo off
title MyOptionDiary — Electron Build
color 0B

:: Always work relative to where this .bat file lives
set "ROOT=%~dp0"
set "TRADE=%~dp0trade-tracker"
set "LICGEN=%~dp0license-generator"

cd /d "%ROOT%"

echo.
echo  +===========================================+
echo  ^|    MyOptionDiary — ELECTRON BUILD        ^|
echo  +===========================================+
echo.
echo  Builds the app into a single .exe installer.
echo  Expected time: 5-10 minutes on first run.
echo.
echo  What gets bundled:
echo  ┌─ React frontend (webpack bundle)
echo  │    src/api/demoEngine.js      Demo data engine (isolated from live)
echo  │    src/utils/tradingCalendar.js  Holiday engine + shared risk-free rate
echo  │    src/utils/yahooQuotes.js   Yahoo Finance price fetcher
echo  │    src/components/*.jsx       All UI components
echo  │    src/App.jsx                Main app, live+demo routing
echo  └─ Node.js backend (separate process)
echo       trade-tracker-backend.js   SQLite API (live mode only)
echo       node_modules/              Backend dependencies
echo       node-bin/node.exe          Bundled portable Node.js runtime
echo.
echo  Live mode:  App.jsx calls trade-tracker-backend.js via HTTP
echo  Demo mode:  App.jsx uses demoEngine.js (in-memory, no backend calls)
echo.

:: ── STEP 1: Check Node.js ────────────────────────────────────────────
echo  Step 1: Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Install from: https://nodejs.org/en/download
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  [OK] Node.js %NODE_VER%
echo.

:: ── STEP 2: Check Windows Build Tools ────────────────────────────────
:: NOTE: build tools are needed for electron-builder, NOT for sql.js.
:: The app uses sql.js (pure JS WASM) — no native module compilation needed.
:: electron-builder itself (for packaging) still needs some build tooling on Windows.
echo  Step 2: Checking Windows Build Tools...
if exist "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC" (
    echo  [OK] Visual Studio 2022 Build Tools found
    goto build_tools_done
)
if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC" (
    echo  [OK] Visual Studio 2019 Build Tools found
    goto build_tools_done
)
where cl.exe >nul 2>&1
if %errorlevel% equ 0 (
    echo  [OK] Windows Build Tools already installed
    goto build_tools_done
)
echo  [INFO] Windows Build Tools not found — downloading...
powershell -Command "Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_buildtools.exe' -OutFile '%TEMP%\vs_buildtools.exe' -UseBasicParsing"
if %errorlevel% neq 0 (
    echo  [ERROR] Could not download VS Build Tools. Check internet connection.
    pause
    exit /b 1
)
echo  Installing — this takes several minutes. Do NOT close this window.
"%TEMP%\vs_buildtools.exe" --quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
del "%TEMP%\vs_buildtools.exe" >nul 2>&1
echo  [OK] Build Tools installed. You may need to restart and re-run this script.

:build_tools_done
echo.

:: ── STEP 3: Export licenses ───────────────────────────────────────────
echo  Step 3: Exporting license database...
if not exist "%LICGEN%\my-licenses.db" (
    echo  [INFO] my-licenses.db not found - skipping license export.
    goto licenses_done
)
pushd "%LICGEN%"
call npm install --silent >nul 2>&1
call node export-licenses.js
if %errorlevel% neq 0 (
    echo  [WARN] License export failed - continuing anyway
) else (
    echo  [OK] Licenses exported to trade-tracker/public/license-db.json
)
popd

:licenses_done
echo.

:: ── STEP 4: Install app dependencies ─────────────────────────────────
echo  Step 4: Installing dependencies...
pushd "%TRADE%"

:: Remove problematic packages before install
if exist "node_modules\dmg-license"   rmdir /s /q "node_modules\dmg-license"   >nul 2>&1
if exist "node_modules\.cache"        rmdir /s /q "node_modules\.cache"         >nul 2>&1

call npm install --legacy-peer-deps 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] npm install failed. Try running as administrator.
    popd
    pause
    exit /b 1
)
if exist "node_modules\dmg-license" rmdir /s /q "node_modules\dmg-license" >nul 2>&1
echo  [OK] Dependencies installed
echo.

:: ── STEP 4.5: Download portable Node.js for bundling ─────────────────
:: This node.exe is bundled INTO the installer so clients don't need Node.js installed.
:: The backend (trade-tracker-backend.js) is spawned using this bundled binary.
:: The React frontend and all demo/live engine code runs in Electron's renderer process
:: (Chromium) — it does NOT use this node.exe.
echo  Step 4.5: Checking for bundled Node.js binary...
if exist "%TRADE%\node-bin\node.exe" (
    echo  [OK] node.exe already present - skipping download
    goto node_bin_done
)

echo  [INFO] Downloading portable Node.js 20 LTS for bundling...
echo  [INFO] This lets the app run on PCs without Node.js installed.
if not exist "%TRADE%\node-bin" mkdir "%TRADE%\node-bin"

powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.19.0/node-v20.19.0-win-x64.zip' -OutFile '%TRADE%\node-bin\node.zip' -UseBasicParsing"
if %errorlevel% neq 0 (
    echo  [ERROR] Could not download Node.js. Check internet connection.
    popd
    pause
    exit /b 1
)

powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('%TRADE%\node-bin\node.zip'); $entry = $zip.Entries | Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '%TRADE%\node-bin\node.exe', $true); $zip.Dispose()"
if %errorlevel% neq 0 (
    echo  [ERROR] Could not extract node.exe from zip.
    popd
    pause
    exit /b 1
)
del "%TRADE%\node-bin\node.zip" >nul 2>&1
echo  [OK] node.exe ready

:node_bin_done
echo.

:: ── STEP 5: Database module check ─────────────────────────────────────
:: sql.js is a pure JavaScript / WASM SQLite implementation.
:: It requires NO native compilation and NO electron-rebuild step.
:: This is why BUILD-ELECTRON.bat has no 'electron-rebuild' call —
:: that was only needed for better-sqlite3 (which this app does NOT use).
echo  Step 5: Checking database module...
if exist "%TRADE%\node_modules\sql.js\dist\sql-wasm.wasm" (
    echo  [OK] sql.js WASM binary present
) else (
    echo  [WARN] sql.js WASM not found - will be installed by npm in Step 4
)
echo  [INFO] sql.js is pure JavaScript - no native rebuild required
echo.

:: ── STEP 6: Check for app icon ────────────────────────────────────────
echo  Step 6: Checking for app icon...
if not exist "electron\icon.ico" (
    echo  [INFO] No icon.ico found - will use default Electron icon.
    echo  [INFO] To add a custom icon: place a 256x256 .ico file at electron\icon.ico
) else (
    echo  [OK] icon.ico found
)
echo.

:: ── STEP 7: Build React app ───────────────────────────────────────────
:: webpack bundles the entire src/ tree into build/static/js/main.*.js
:: This includes:
::   - demoEngine.js (demo data, fully isolated from live backend)
::   - tradingCalendar.js (shared holiday engine + risk-free rate)
::   - yahooQuotes.js (Yahoo Finance price fetcher for no-live-connection clients)
::   - All components, App.jsx, license logic
:: The React build output (build/) is then copied to resources/app/ by electron-builder.
echo  Step 7: Building React app (webpack bundle)...
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
echo  [OK] demoEngine.js, tradingCalendar.js, yahooQuotes.js all bundled
echo.

:: ── STEP 8: Verify resource paths ────────────────────────────────────
:: electron-builder will copy these via extraResources in package.json:
::   build/         → resources/app/      (React bundle - served as static files)
::   trade-tracker-backend.js → resources/backend/ (Node.js live data API)
::   node_modules/  → resources/backend/node_modules/
::   node-bin/node.exe → resources/node/node.exe
echo  Step 8: Verifying build artifacts...
if not exist "build\index.html" (
    echo  [ERROR] build\index.html missing - React build may have failed.
    popd
    pause
    exit /b 1
)
if not exist "trade-tracker-backend.js" (
    echo  [ERROR] trade-tracker-backend.js not found.
    popd
    pause
    exit /b 1
)
echo  [OK] build\index.html present (React bundle)
echo  [OK] trade-tracker-backend.js present (live backend)
echo.

:: ── STEP 9: Package with electron-builder ────────────────────────────
echo  Step 9: Packaging into .exe installer...
call npx electron-builder --win --x64
if %errorlevel% neq 0 (
    echo  [ERROR] Packaging failed. Check the output above.
    popd
    pause
    exit /b 1
)
popd
echo  [OK] Packaging complete
echo.

:: ── DONE ─────────────────────────────────────────────────────────────
echo  +===========================================+
echo  ^|          BUILD COMPLETE!                 ^|
echo  +===========================================+
echo.
echo  Installer location:
echo  trade-tracker\dist\MyOptionDiary Setup 5.1.0.exe
echo.
echo  Installed app behaviour:
echo    - Launches Electron (Chromium renderer)
echo    - Spawns trade-tracker-backend.js via bundled node.exe
echo    - App starts in Demo Mode (demoEngine.js, in-memory)
echo    - User clicks Live Mode to connect broker (backend API)
echo    - Yahoo Finance fetcher works from both Demo and Live Mode
echo    - Manual prices persist across sessions via localStorage
echo.
echo  Send the .exe to clients. They double-click to install.
echo  No Node.js or browser required on their machine.
echo.
pause
