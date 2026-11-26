@echo off
cd /d "%~dp0"
if not exist ".voice-venv\Scripts\python.exe" python -m venv .voice-venv
if errorlevel 1 goto failed
".voice-venv\Scripts\python.exe" -m pip install -r scripts\requirements-voice.txt
if errorlevel 1 goto failed
echo Natural dialogue voices are ready. Restart the game service and refresh the page.
pause
exit /b 0
:failed
echo Voice setup failed. Please install Python 3.10 or newer, then run this file again.
pause
exit /b 1
