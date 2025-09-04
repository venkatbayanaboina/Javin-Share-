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

echo => Device IP detected: %DEVICE_IP%
echo => Will open: %URL%
echo.

:: Elevate if not admin
openfiles >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -Command "Start-Process -Verb RunAs cmd -ArgumentList '/c ""%~f0""'"
  exit /b
)

echo => Installing backend dependencies...
pushd "%BACKEND_DIR%"
call npm install --silent

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

echo => Starting server (https) on %URL% ...
echo => Server will start in a new window...
echo => This window will stay open to show server status
echo.

start "fileshare-backend" cmd /c "cd /d %BACKEND_DIR% && node server.js && pause"

echo => Opening %URL% in your default browser
timeout /t 3 /nobreak >nul
start "" "%URL%"

echo.
echo => Server started! Check the new window for server status.
echo => Press any key to close this window...
pause >nul

popd
popd
endlocal

