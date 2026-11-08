@echo off
cd /d "%~dp0"
call npm install
call npm run dist
for %%f in ("dist\Bot Dashboard Setup *.exe") do start "" "%%f"
