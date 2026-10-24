@echo off
cd /d "%~dp0.."
echo.
echo   [Zen-Dock] creating .venv for the desktop shell...
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo   python not found in PATH. Install Python 3.10+ first.
  pause
  exit /b 1
)

python -m venv .venv
if errorlevel 1 (
  echo   failed to create .venv
  pause
  exit /b 1
)

".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r shell\requirements.txt
if errorlevel 1 (
  echo   failed to install dependencies
  pause
  exit /b 1
)

echo.
echo   done. double-click zen-dock-window.bat to open the window.
echo.
pause
