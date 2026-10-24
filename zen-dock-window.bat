@echo off
cd /d "%~dp0"

if not exist ".venv\Scripts\pythonw.exe" (
  echo.
  echo   [Zen-Dock] .venv not found.
  echo   Run shell\setup.bat first to create it.
  echo.
  pause
  exit /b 1
)

start "" ".venv\Scripts\pythonw.exe" "shell\desktop.py" %*
exit /b 0
