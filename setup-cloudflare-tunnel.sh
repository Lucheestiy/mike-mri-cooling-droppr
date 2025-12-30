#!/bin/bash

set -euo pipefail

DROPPR_DIR="/home/mlweb/mri-cooling-droppr"
CLOUDFLARE_DIR="${DROPPR_DIR}/cloudflare"
CREDS_DIR="${CLOUDFLARE_DIR}/creds"

echo "=== Cloudflare Tunnel Setup for Droppr (droppr.coolmri.com) ==="
echo ""
echo "This will create an independent Cloudflare tunnel for Droppr."
echo ""
echo "Prerequisites:"
echo "1. Cloudflare account with coolmri.com domain"
echo "2. cloudflared CLI installed and available in PATH"
echo ""
echo "Press Enter to continue..."
read -r

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "ERROR: cloudflared CLI is not installed."
  exit 1
fi

echo "Checking Cloudflare login..."
if ! cloudflared tunnel list >/dev/null 2>&1; then
  echo "Logging into Cloudflare..."
  cloudflared tunnel login
fi

TUNNEL_NAME="coolmri-droppr-tunnel"

if cloudflared tunnel list | awk '{print $2}' | grep -qx "${TUNNEL_NAME}"; then
  echo "Tunnel '${TUNNEL_NAME}' already exists; reusing it."
else
  echo "Creating tunnel '${TUNNEL_NAME}'..."
  cloudflared tunnel create "${TUNNEL_NAME}"
fi

TUNNEL_ID="$(cloudflared tunnel list | awk -v name="${TUNNEL_NAME}" '$2==name {print $1}' | head -n 1)"
echo "Droppr Tunnel ID: ${TUNNEL_ID}"

if [ -z "${TUNNEL_ID}" ]; then
  echo "ERROR: Failed to determine tunnel ID for '${TUNNEL_NAME}'."
  exit 1
fi

mkdir -p "${CREDS_DIR}"
cp "${HOME}/.cloudflared/${TUNNEL_ID}.json" "${CREDS_DIR}/credentials.json"

cat > "${CLOUDFLARE_DIR}/config.yml" << EOF
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/creds/credentials.json
protocol: http2

ingress:
  - hostname: droppr.coolmri.com
    service: http://droppr:80
    originRequest:
      noTLSVerify: true

  - service: http_status:404
EOF

echo ""
echo "✅ Droppr tunnel created successfully!"
echo ""
echo "🌐 DNS Configuration Required (Cloudflare DNS):"
echo "Type: CNAME"
echo "Name: droppr"
echo "Content: ${TUNNEL_ID}.cfargotunnel.com"
echo "Proxy: ✅ Proxied"
echo ""
echo "📋 Next Steps:"
echo "1. Add the DNS record above in Cloudflare Dashboard"
echo "2. Start Droppr (including tunnel):"
echo "   cd ${DROPPR_DIR} && docker compose --profile tunnel up -d"
echo "3. Test: https://droppr.coolmri.com"
echo ""
echo "Tunnel configuration saved to:"
echo "  - Config: ${CLOUDFLARE_DIR}/config.yml"
echo "  - Credentials: ${CREDS_DIR}/credentials.json"
