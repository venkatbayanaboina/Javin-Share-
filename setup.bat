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
echo    JAVIN FileShare - Complete Setup
echo ========================================
echo.
echo => Device IP detected: %DEVICE_IP%
echo => Server URL: %URL%
echo.

:: Elevate if not admin
openfiles >nul 2>&1
if %errorlevel% NEQ 0 (
  echo => Requesting administrator privileges...
  powershell -Command "Start-Process -Verb RunAs cmd -ArgumentList '/c ""%~f0""'"
  exit /b
)

echo => Installing backend dependencies...
pushd "%BACKEND_DIR%"
if not exist package.json (
    echo => ERROR: package.json not found in backend directory!
    echo => Please make sure you're running this from the correct location.
    pause
    exit /b 1
)
call npm install --silent
if %errorlevel% neq 0 (
    echo => ERROR: npm install failed!
    echo => Please check if Node.js is installed correctly.
    pause
    exit /b 1
)

if not exist "%BACKEND_DIR%\certs" mkdir "%BACKEND_DIR%\certs"

:: Generate cert if missing (requires OpenSSL in PATH)
if not exist "%BACKEND_DIR%\certs\cert.pem" (
  if exist "%ProgramFiles%\Git\usr\bin\openssl.exe" (
    set OPENSSL="%ProgramFiles%\Git\usr\bin\openssl.exe"
  ) else (
    set OPENSSL=openssl
  )
  echo => Generating self-signed certs (dev only) for IP: %DEVICE_IP%
  
  :: Create a config file for the certificate with both localhost and the device IP
  echo [req] > "%BACKEND_DIR%\certs\cert.conf"
  echo distinguished_name = req_distinguished_name >> "%BACKEND_DIR%\certs\cert.conf"
  echo req_extensions = v3_req >> "%BACKEND_DIR%\certs\cert.conf"
  echo prompt = no >> "%BACKEND_DIR%\certs\cert.conf"
  echo. >> "%BACKEND_DIR%\certs\cert.conf"
  echo [req_distinguished_name] >> "%BACKEND_DIR%\certs\cert.conf"
  echo C = US >> "%BACKEND_DIR%\certs\cert.conf"
  echo ST = State >> "%BACKEND_DIR%\certs\cert.conf"
  echo L = City >> "%BACKEND_DIR%\certs\cert.conf"
  echo O = Organization >> "%BACKEND_DIR%\certs\cert.conf"
  echo OU = OrgUnit >> "%BACKEND_DIR%\certs\cert.conf"
  echo CN = %DEVICE_IP% >> "%BACKEND_DIR%\certs\cert.conf"
  echo. >> "%BACKEND_DIR%\certs\cert.conf"
  echo [v3_req] >> "%BACKEND_DIR%\certs\cert.conf"
  echo basicConstraints = CA:FALSE >> "%BACKEND_DIR%\certs\cert.conf"
  echo keyUsage = nonRepudiation, digitalSignature, keyEncipherment >> "%BACKEND_DIR%\certs\cert.conf"
  echo extendedKeyUsage = serverAuth >> "%BACKEND_DIR%\certs\cert.conf"
  echo subjectAltName = @alt_names >> "%BACKEND_DIR%\certs\cert.conf"
  echo. >> "%BACKEND_DIR%\certs\cert.conf"
  echo [alt_names] >> "%BACKEND_DIR%\certs\cert.conf"
  echo DNS.1 = localhost >> "%BACKEND_DIR%\certs\cert.conf"
  echo DNS.2 = %DEVICE_IP% >> "%BACKEND_DIR%\certs\cert.conf"
  echo IP.1 = 127.0.0.1 >> "%BACKEND_DIR%\certs\cert.conf"
  echo IP.2 = %DEVICE_IP% >> "%BACKEND_DIR%\certs\cert.conf"
  
  %OPENSSL% req -x509 -newkey rsa:2048 -nodes -keyout "%BACKEND_DIR%\certs\key.pem" -out "%BACKEND_DIR%\certs\cert.pem" -days 365 -config "%BACKEND_DIR%\certs\cert.conf" -extensions v3_req
  del "%BACKEND_DIR%\certs\cert.conf"
)

:: Trust the certificate if possible
if exist "%BACKEND_DIR%\certs\cert.pem" (
  echo => Installing/Trusting local HTTPS certificate
  certutil -addstore -f "Root" "%BACKEND_DIR%\certs\cert.pem" >nul 2>&1
)

echo.
echo ========================================
echo    Starting FileShare Server
echo ========================================
echo => Server URL: %URL%
echo => Opening browser in 3 seconds...
echo => Press Ctrl+C to stop the server
echo.

:: Open browser after 3 seconds
timeout /t 3 /nobreak >nul
start "" "%URL%"

echo => Starting server...
echo => Server is now running! Check your browser.
echo => This window will stay open to show server status.
echo => Press Ctrl+C to stop the server.
echo.

:: Start the server (this keeps the window open)
cd "%BACKEND_DIR%"
if not exist server.js (
    echo => ERROR: server.js not found in backend directory!
    echo => Please make sure you're running this from the correct location.
    pause
    exit /b 1
)
echo => Starting server from: %CD%
node server.js

popd
endlocal

