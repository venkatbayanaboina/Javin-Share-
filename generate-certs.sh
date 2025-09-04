#!/bin/bash
set -e

CERTS_DIR="backend/certs"
KEY_FILE="$CERTS_DIR/server.key"
CERT_FILE="$CERTS_DIR/server.cert"

# Create the folder if it doesn't exist
mkdir -p "$CERTS_DIR"

# If certs already exist, don't overwrite
if [ -f "$KEY_FILE" ] && [ -f "$CERT_FILE" ]; then
  echo "✔ Dev certs already exist at $CERTS_DIR"
  exit 0
fi

# Generate new self-signed certs
echo "🔑 Generating self-signed dev certificates for localhost..."
openssl req -nodes -new -x509 \
  -keyout "$KEY_FILE" \
  -out "$CERT_FILE" \
  -days 365 \
  -subj "/CN=localhost"

echo "✔ Created:"
ls -l "$KEY_FILE" "$CERT_FILE"
