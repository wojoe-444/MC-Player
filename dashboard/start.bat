@echo off
cd /d "%~dp0"
rem Point the dashboard at the live bot folders (override by setting these before running).
if not defined BOT_OZO_DIR set "BOT_OZO_DIR=%~dp0..\..\Minecraft-Survival"
if not defined BOT_SMEO_DIR set "BOT_SMEO_DIR=%~dp0..\..\Minecraft-Smeo"
if not defined BOT_CODE_DIR set "BOT_CODE_DIR=%~dp0..\..\Minecraft-Survival"
echo Bot Dashboard on http://localhost:8765
node server.js
