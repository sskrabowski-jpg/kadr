#!/usr/bin/env bash
# Installs or updates Kadr on a fresh Ubuntu/Debian server.
#   curl -fsSL https://raw.githubusercontent.com/sskrabowski-jpg/kadr/main/deploy/install.sh | sudo bash
# Re-running it updates to the latest version and keeps your settings and videos.
set -euo pipefail

REPO="https://github.com/sskrabowski-jpg/kadr.git"
DIR="/opt/kadr"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ask() { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root (через sudo)."; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  say "Устанавливаю Docker…"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }

if [ -d "$DIR/.git" ]; then
  say "Обновляю код…"
  git -C "$DIR" pull --ff-only
else
  say "Скачиваю код…"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  IP="$(curl -fsS https://api.ipify.org || true)"
  echo
  echo "Адрес сайта. Если домена пока нет — просто нажмите Enter,"
  echo "и сайт будет доступен по временному адресу ${IP//./-}.sslip.io"
  DOMAIN="$(ask 'Домен (например video.example.ru): ')"
  [ -n "$DOMAIN" ] || DOMAIN="${IP//./-}.sslip.io"
  PASSWORD=""
  while [ ${#PASSWORD} -lt 8 ]; do
    PASSWORD="$(ask 'Придумайте пароль для записи видео (от 8 символов): ')"
  done
  umask 077
  printf 'DOMAIN=%s\nKADR_PASSWORD=%s\nMAX_VIDEO_MB=2048\n' "$DOMAIN" "$PASSWORD" > .env
fi
DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2-)"

RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)"
IP="${IP:-$(curl -fsS https://api.ipify.org || true)}"
if [ -n "$IP" ] && [ "$RESOLVED" != "$IP" ]; then
  echo
  echo "ВНИМАНИЕ: домен $DOMAIN сейчас указывает на '${RESOLVED:-никуда}', а IP этого сервера — $IP."
  echo "Пропишите у регистратора домена A-запись $DOMAIN -> $IP и запустите скрипт ещё раз"
  echo "(обновление DNS иногда занимает до часа). Без этого HTTPS-сертификат не выпустится."
fi

say "Собираю и запускаю (первый раз — несколько минут)…"
docker compose up -d --build
docker image prune -f >/dev/null

say "Готово! Откройте https://$DOMAIN"
echo "Пароль для записи лежит в $DIR/.env"
