#!/usr/bin/env bash
# Obtains the Let's Encrypt certificate (one certificate named "edu" covering the three
# domains) and reloads Nginx. Run once after `docker compose up -d`, from backend/deploy.
# Renewals are automatic (certbot service).
#
# Usage: bash scripts/issue-certificate.sh [--staging]
set -euo pipefail
cd "$(dirname "$0")/.."

# Read only the values we need (.env is not sourced: some values contain spaces).
env_value() {
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '\r' | tr -d "\"'"
}
API_DOMAIN="$(env_value API_DOMAIN)"
OWNER_DOMAIN="$(env_value OWNER_DOMAIN)"
ADMIN_DOMAIN="$(env_value ADMIN_DOMAIN)"
LETSENCRYPT_EMAIL="$(env_value LETSENCRYPT_EMAIL)"
: "${API_DOMAIN:?API_DOMAIN missing in .env}" "${OWNER_DOMAIN:?OWNER_DOMAIN missing in .env}"
: "${ADMIN_DOMAIN:?ADMIN_DOMAIN missing in .env}" "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL missing in .env}"

STAGING=()
if [ "${1:-}" = "--staging" ]; then STAGING=(--staging); fi

# Remove the self-signed placeholder created by the edge container on first boot.
docker compose run --rm --entrypoint sh certbot -c '
  if [ -f /etc/letsencrypt/live/edu/fullchain.pem ] && [ ! -f /etc/letsencrypt/renewal/edu.conf ]; then
    rm -rf /etc/letsencrypt/live/edu
  fi'

docker compose run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot \
  --cert-name edu \
  -d "$API_DOMAIN" -d "$OWNER_DOMAIN" -d "$ADMIN_DOMAIN" \
  --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email \
  --non-interactive "${STAGING[@]}"

docker compose exec edge nginx -s reload
echo "Certificate installed for $API_DOMAIN, $OWNER_DOMAIN, $ADMIN_DOMAIN"
