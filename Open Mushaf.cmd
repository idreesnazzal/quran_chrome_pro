@echo off
cd /d "%~dp0"
netstat -ano | findstr /r /c:"127.0.0.1:8001 .*LISTENING" >nul || start "" "C:\Users\idree\AppData\Local\Programs\Python\Python312\pythonw.exe" "%~dp0server\recite_server.py" --port 8001 --no-model
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:8001/
