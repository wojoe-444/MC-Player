@echo off
cd /d "%~dp0"
if not exist dist call npm run build
node serve.mjs 8472
