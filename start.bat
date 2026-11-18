@echo off
title TwitchIO
cd /d "%~dp0"
if not exist node_modules\web-push\package.json (
  call npm ci --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
:boucle
node index.js
echo.
echo L'addon s'est arrete. Redemarrage dans 5 secondes (ferme cette fenetre pour quitter)...
timeout /t 5 /nobreak >nul
goto boucle
