@echo off
setlocal ENABLEDELAYEDEXPANSION

set SCRIPT_DIR=%~dp0
set BACKEND_DIR=%SCRIPT_DIR%backend
set PORT=4000

:: Get the device's IP address
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    for /f "tokens=1" %%b in ("%%a") do set DEVICE_IP=%%b
)

:: Fallback to localhost if IP detection fails
if "%DEVICE_IP%"=="" set DEVICE_IP=localhost
if "%DEVICE_IP%"=="127.0.0.1" set DEVICE_IP=localhost

set URL=https://%DEVICE_IP%:%PORT%

echo ========================================
echo    JAVIN FileShare - Quick Start
echo ========================================
echo.
echo => Device IP: %DEVICE_IP%
echo => Server URL: %URL%
echo.

:: Check if dependencies are installed
if not exist "%BACKEND_DIR%\node_modules" (
    echo => Installing dependencies first...
    pushd "%BACKEND_DIR%"
    call npm install
    popd
    echo.
)

:: Check if certificates exist
if not exist "%BACKEND_DIR%\certs\cert.pem" (
    echo => Generating certificates...
    if not exist "%BACKEND_DIR%\certs" mkdir "%BACKEND_DIR%\certs"
    
    if exist "%ProgramFiles%\Git\usr\bin\openssl.exe" (
        set OPENSSL="%ProgramFiles%\Git\usr\bin\openssl.exe"
    ) else (
        set OPENSSL=openssl
    )
    
    %OPENSSL% req -x509 -newkey rsa:2048 -nodes -keyout "%BACKEND_DIR%\certs\key.pem" -out "%BACKEND_DIR%\certs\cert.pem" -days 365 -subj "/CN=localhost"
    echo => Certificates generated!
    echo.
)

echo => Starting FileShare server...
echo => Opening browser in 3 seconds...
echo => Press Ctrl+C to stop the server
echo.

:: Open browser after 3 seconds
start "" "%URL%"

:: Start the server (this will keep the window open)
pushd "%BACKEND_DIR%"
node server.js

popd
endlocal
