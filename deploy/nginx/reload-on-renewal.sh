#!/bin/sh
# Runs from the nginx image entrypoint (/docker-entrypoint.d) before Nginx starts.
set -eu

CERT_DIR=/etc/letsencrypt/live/edu

# First boot: Nginx cannot start without a certificate, so create a short-lived self-signed
# placeholder. deploy/scripts/issue-certificate.sh replaces it with a Let's Encrypt certificate.
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  echo "No certificate yet: creating a temporary self-signed one"
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 -days 7 \
    -keyout "$CERT_DIR/privkey.pem" -out "$CERT_DIR/fullchain.pem" \
    -subj "/CN=${API_DOMAIN:-localhost}" >/dev/null 2>&1
fi

# Pick up renewed certificates (certbot renews in its own container).
(
  while :; do
    sleep 21600
    nginx -s reload || true
  done
) &
