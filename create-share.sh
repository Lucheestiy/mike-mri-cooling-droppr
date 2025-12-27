#!/bin/bash
# Script to create FileBrowser shares via API

echo "Creating new share for folder..."

# Login and get token
TOKEN=$(curl -s -X POST https://droppr.coolmri.com/api/login \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"4E1LHCsY_0jnk51J"}')

echo "Got authentication token"

# Create share (adjust path as needed)
FOLDER_PATH="${1:-/2}"
SHARE_RESPONSE=$(curl -s -X POST "https://droppr.coolmri.com/api/share${FOLDER_PATH}" \
     -H "X-Auth: $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"expires":"", "password":""}')

echo "Share created: $SHARE_RESPONSE"

# Extract hash if successful
if [[ $SHARE_RESPONSE == *"hash"* ]]; then
    HASH=$(echo "$SHARE_RESPONSE" | grep -o '"hash":"[^"]*"' | cut -d'"' -f4)
    echo "✅ Share URL: https://droppr.coolmri.com/api/public/dl/$HASH"
    echo "📱 This will redirect to beautiful media gallery!"
else
    echo "❌ Failed to create share: $SHARE_RESPONSE"
fi