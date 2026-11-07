@echo off
title Panel de Licencias UiXtream (Puerto 8000)
color 0B
cd /d "%~dp0"

echo ==============================================================================
echo        PANEL DE LICENCIAS UIXTREAM - MODO SUPABASE CLOUD 24/7 (PUERTO 8000)
echo ==============================================================================
echo.

netstat -ano | findstr :8000 | findstr LISTENING >nul
if %errorlevel% neq 0 (
    echo [*] Iniciando servidor UiXtream en puerto 8000...
    where node >nul 2>nul
    if not errorlevel 1 (
        start "UiXtream (Puerto 8000)" /min node server.js
    ) else if exist "%~dp0UiXtreamLicenseServer.exe" (
        start "UiXtream (Puerto 8000)" /min "%~dp0UiXtreamLicenseServer.exe"
    ) else (
        echo [ERROR] No se encontro Node.js ni UiXtreamLicenseServer.exe.
        pause
        exit /b 1
    )
    timeout /t 2 /nobreak >nul
) else (
    echo [*] El servidor en puerto 8000 ya esta activo.
    echo [!] Si el panel sigue mostrando la version anterior, cierra su proceso y vuelve a ejecutar este archivo.
)

echo [*] Abriendo Panel UiXtream en tu navegador (http://localhost:8000)...
start http://localhost:8000

