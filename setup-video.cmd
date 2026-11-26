@echo off
cd /d "%~dp0"
if not exist .video-venv\Scripts\python.exe python -m venv .video-venv
if errorlevel 1 goto fail
.video-venv\Scripts\python.exe -m pip install --disable-pip-version-check imageio-ffmpeg==0.6.0
if errorlevel 1 goto fail
echo Video tools ready. Restart the game service if it is running.
pause
exit /b 0
:fail
echo Could not install video tools. Check Python and network availability.
pause
exit /b 1
