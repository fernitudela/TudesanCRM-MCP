@echo off
REM Instalador de doble clic (Windows). Equivale a ejecutar setup.ps1 con PowerShell.
REM No requiere permisos de administrador. Se abrira el navegador para el login de Google.
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
