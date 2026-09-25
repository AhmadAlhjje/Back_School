#!/usr/bin/env bash
# Creates .env for docker-compose.yml from .env.production.example — once, on the server:
#
#   bash docker/init-env.sh
#
# Passwords and secrets get random values; the first super admin account is asked here.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

if [ -f .env ]; then
  echo "✗ .env already exists — nothing changed. (الملف .env موجود مسبقاً)"
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "✗ openssl is required: apt-get install -y openssl"
  exit 1
fi

echo "First super admin account — حساب المشرف العام"
read -rp "  Name / الاسم [المشرف العام]: " name
name="${name:-المشرف العام}"
name="${name//\'/}"

while true; do
  read -rp "  Phone (login) / رقم الهاتف للدخول: " phone
  phone="${phone// /}"
  [[ "$phone" =~ ^\+?[0-9]{8,15}$ ]] && break
  echo "  ✗ 8-15 digits, e.g. 0912345678 / رقم غير صالح"
done

while true; do
  read -rsp "  Password / كلمة المرور (8+ characters, English letters and digits): " password
  echo
  if [ "${#password}" -lt 8 ] || ! [[ "$password" =~ [0-9] ]] || ! [[ "$password" =~ [A-Za-z] ]]; then
    echo "  ✗ At least 8 characters with English letters and digits / 8 أحرف على الأقل: حروف إنجليزية وأرقام"
    continue
  fi
  if [[ "$password" == *"'"* ]]; then
    echo "  ✗ The character ' is not allowed / لا تستخدم الرمز '"
    continue
  fi
  read -rsp "  Repeat / أعد كتابتها: " again
  echo
  [ "$password" = "$again" ] && break
  echo "  ✗ The passwords do not match / غير متطابقتين"
done

hex() { openssl rand -hex "$1"; }

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    DB_PASSWORD=*) echo "DB_PASSWORD=$(hex 24)" ;;
    DB_ROOT_PASSWORD=*) echo "DB_ROOT_PASSWORD=$(hex 24)" ;;
    REDIS_PASSWORD=*) echo "REDIS_PASSWORD=$(hex 24)" ;;
    JWT_ACCESS_SECRET=*) echo "JWT_ACCESS_SECRET=$(hex 32)" ;;
    MEDIA_TOKEN_SECRET=*) echo "MEDIA_TOKEN_SECRET=$(hex 32)" ;;
    MEDIA_KEY_ENCRYPTION_KEY=*) echo "MEDIA_KEY_ENCRYPTION_KEY=$(openssl rand -base64 32)" ;;
    SEED_SUPER_ADMIN_NAME=*) printf "SEED_SUPER_ADMIN_NAME='%s'\n" "$name" ;;
    SEED_SUPER_ADMIN_PHONE=*) echo "SEED_SUPER_ADMIN_PHONE=$phone" ;;
    SEED_SUPER_ADMIN_PASSWORD=*) printf "SEED_SUPER_ADMIN_PASSWORD='%s'\n" "$password" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env.production.example > .env

address="$(sed -n 's/^SERVER_ADDRESS=//p' .env)"
port="$(sed -n 's/^API_PORT=//p' .env)"
echo
echo "✓ .env created (random passwords and secrets). Keep a copy of it somewhere safe."
echo "  API address for the app: http://${address}:${port}"
echo "  Next / الخطوة التالية:  docker compose up -d --build"
