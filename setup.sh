#!/usr/bin/env bash
set -euo pipefail

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

echo "=> Device IP detected: $DEVICE_IP"
echo "=> Will open: $URL"
echo ""

echo "=> Installing backend dependencies..."
cd "$BACKEND_DIR"
npm install --silent

echo "=> Ensuring HTTPS certificates..."
# Check if certs exist and have correct key usage, regenerate if needed
REGENERATE_CERT=false
if [ ! -f "$BACKEND_DIR/certs/cert.pem" ] || [ ! -f "$BACKEND_DIR/certs/key.pem" ]; then
  REGENERATE_CERT=true
else
  # Check if existing cert has correct key usage
  if ! openssl x509 -in "$BACKEND_DIR/certs/cert.pem" -text -noout | grep -q "Digital Signature, Key Encipherment"; then
    echo "=> Existing certificate has incorrect key usage, regenerating..."
    REGENERATE_CERT=true
  fi
fi

if [ "$REGENERATE_CERT" = true ]; then
  echo "=> Generating self-signed certs (dev only) for IP: $DEVICE_IP"
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
fi

echo "=> Installing/Trusting local HTTPS certificate (requires sudo)"
if [[ "${OSTYPE:-}" == darwin* ]]; then
  # macOS: trust the certificate in System keychain (ignore errors if already trusted)
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$BACKEND_DIR/certs/cert.pem" 2>/dev/null || true
else
  # Linux: try Debian/Ubuntu first, then Fedora/RHEL, then p11-kit trust
  if command -v update-ca-certificates >/dev/null 2>&1; then
    sudo mkdir -p /usr/local/share/ca-certificates
    sudo cp "$BACKEND_DIR/certs/cert.pem" /usr/local/share/ca-certificates/fileshare_local.crt
    sudo update-ca-certificates || true
  elif command -v update-ca-trust >/dev/null 2>&1; then
    sudo mkdir -p /etc/pki/ca-trust/source/anchors
    sudo cp "$BACKEND_DIR/certs/cert.pem" /etc/pki/ca-trust/source/anchors/fileshare_local.crt
    sudo update-ca-trust extract || true
  elif command -v trust >/dev/null 2>&1; then
    sudo trust anchor "$BACKEND_DIR/certs/cert.pem" || true
  else
    echo "=> Could not find a system trust utility. You may see a browser warning for self-signed certs."
  fi
fi

echo "=> Starting server (https) on $URL ..."
node "$BACKEND_DIR/server.js" &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 1
echo "=> Opening $URL in your default browser"
if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
else
  echo "Open this URL manually: $URL"
fi

wait "$SERVER_PID"

