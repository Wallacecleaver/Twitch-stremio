@echo off
title Twitch pour Stremio
cd /d "%~dp0"
:boucle
node index.js
echo.
echo L'addon s'est arrete. Redemarrage dans 5 secondes (ferme cette fenetre pour quitter)...
timeout /t 5 /nobreak >nul
goto boucle
