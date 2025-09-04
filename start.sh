#!/bin/bash
# start.sh - Double-clickable launcher for FileShare

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
PORT=4000

# Get the device's IP address
if [[ "${OSTYPE:-}" == darwin* ]]; then
  # macOS
  DEVICE_IP=$(ifconfig | grep -E "inet.*broadcast" | awk '{print $2}' | head -1)
else
  # Linux
  DEVICE_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}' 2>/dev/null || hostname -I | awk '{print $1}' 2>/dev/null || echo "127.0.0.1")
fi

# Fallback to localhost if IP detection fails
if [ -z "$DEVICE_IP" ] || [ "$DEVICE_IP" = "127.0.0.1" ]; then
  DEVICE_IP="localhost"
fi

URL="https://$DEVICE_IP:$PORT"

echo "========================================"
echo "    JAVIN FileShare - Quick Start"
echo "========================================"
echo
echo "=> Device IP detected: $DEVICE_IP"
echo "=> Server URL: $URL"
echo

# Check if dependencies are installed
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
    echo "=> Installing dependencies..."
    cd "$BACKEND_DIR"
    npm install --silent
    cd "$SCRIPT_DIR"
    echo
fi

# Check if certificates exist
if [ ! -f "$BACKEND_DIR/certs/cert.pem" ]; then
    echo "=> Generating certificates..."
    mkdir -p "$BACKEND_DIR/certs"
    
    # Create a config file for the certificate with both localhost and the device IP
    cat > "$BACKEND_DIR/certs/cert.conf" << EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = State
L = City
O = Organization
OU = OrgUnit
CN = $DEVICE_IP

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = $DEVICE_IP
IP.1 = 127.0.0.1
IP.2 = $DEVICE_IP
EOF
    
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$BACKEND_DIR/certs/key.pem" -out "$BACKEND_DIR/certs/cert.pem" -days 365 -config "$BACKEND_DIR/certs/cert.conf" -extensions v3_req
    rm "$BACKEND_DIR/certs/cert.conf"
    echo "=> Certificates generated!"
    echo
fi

echo "========================================"
echo "    Starting FileShare Server"
echo "========================================"
echo "=> Server URL: $URL"
echo "=> Opening browser in 3 seconds..."
echo "=> Press Ctrl+C to stop the server"
echo

# Open browser after 3 seconds
sleep 3
if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
else
  echo "Open this URL manually: $URL"
fi

echo "=> Starting server..."
echo "=> Server is now running! Check your browser."
echo "=> This window will stay open to show server status."
echo "=> Press Ctrl+C to stop the server."
echo

# Start the server (this keeps the window open)
cd "$BACKEND_DIR"
node server.js
