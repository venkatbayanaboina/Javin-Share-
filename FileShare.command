#!/bin/bash
# FileShare.command - Double-clickable macOS launcher

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Change to the script directory
cd "$SCRIPT_DIR"

# Make the start.sh executable
chmod +x start.sh

# Run the start script
./start.sh

# Keep the window open
echo
echo "Press any key to close this window..."
read -n 1 -s
