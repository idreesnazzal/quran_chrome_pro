@echo off
rem Opens the mushaf app through the local server (mic permission is remembered on http://127.0.0.1)
cd /d "%~dp0"
netstat -ano | findstr /r /c:"127.0.0.1:8001 .*LISTENING" >nul || start "Quran server" /min python "%~dp0server\recite_server.py" --port 8001 --no-model
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8001/
