@echo off
cd /d "%~dp0"
call npm install
pushd ..\reviewer
call npm install --omit=dev
popd
call npm run dist
for %%f in ("dist\Bot Dashboard Setup *.exe") do start "" "%%f"
