#!/usr/bin/env bash
# OpenChar Pi-chat — installation complète en une commande.
# Installe / met à jour les trois briques :
#   1. le fork OpenChar (dock chat)        -> ~/OpenChar  (branche pi-chat)
#   2. l'extension Pi « openchar »         -> ~/.pi/agent/extensions/openchar
#   3. l'extension NanoGPT                 -> via l'app (channel ext:manage:install)
# puis démarre le serveur avec le SPA custom sur http://127.0.0.1:8848
#
# Prérequis : git, node >= 20, python 3.11+, uv (auto par webui.sh),
#             `pi` installé et un provider LLM configuré (voir https://github.com/earendil-works/pi-coding-agent),
#             clé NanoGPT optionnelle dans ~/.config/nano-gpt/api_key
set -euo pipefail

OPENCHAR_DIR="${OPENCHAR_DIR:-$HOME/OpenChar}"
FORK_URL="https://github.com/cgarrot/OpenChar.git"
EXT_URL="https://github.com/cgarrot/openchar-pi-chat.git"
NANOGPT_URL="https://github.com/cgarrot/inline-nanogpt"
PI_EXT_DIR="$HOME/.pi/agent/extensions/openchar"
PORT="${INLINE_PORT:-8848}"

step() { printf '\n\033[1;34m== %s ==\033[0m\n' "$1"; }

step "1/4 Fork OpenChar (branche pi-chat) dans $OPENCHAR_DIR"
if [ ! -d "$OPENCHAR_DIR/.git" ]; then
  git clone -b pi-chat "$FORK_URL" "$OPENCHAR_DIR"
else
  git -C "$OPENCHAR_DIR" fetch origin pi-chat
  git -C "$OPENCHAR_DIR" checkout pi-chat
  git -C "$OPENCHAR_DIR" reset --hard origin/pi-chat
fi

step "2/4 Build du SPA (dock chat inclus)"
cd "$OPENCHAR_DIR"
npm ci --no-audit --no-fund
npm run build:spa

step "3/4 Extension Pi « openchar » dans $PI_EXT_DIR"
mkdir -p "$(dirname "$PI_EXT_DIR")"
if [ ! -d "$PI_EXT_DIR/.git" ]; then
  git clone "$EXT_URL" "$PI_EXT_DIR"
else
  git -C "$PI_EXT_DIR" pull --ff-only
fi

step "4/4 Démarrage de Core (http://127.0.0.1:$PORT)"
cd "$OPENCHAR_DIR/core"
export INLINE_RUN_WORKERS="${INLINE_RUN_WORKERS:-3}"
export INLINE_FRONTEND_ROOT="$OPENCHAR_DIR/dist-web"
nohup bash webui.sh > /tmp/openchar-webui.log 2>&1 &
echo "attente du serveur…"
for _ in $(seq 1 30); do
  sleep 1
  curl -sf "http://127.0.0.1:$PORT/rpc" -H 'content-type: application/json' \
    -d '{"channel":"app:version","args":[]}' >/dev/null 2>&1 && break
done

# L'extension NanoGPT s'installe depuis l'app (une seule fois ; idempotent par version)
if curl -sf "http://127.0.0.1:$PORT/rpc" -H 'content-type: application/json' \
  -d "{\"channel\":\"ext:manage:install\",\"args\":[\"$NANOGPT_URL\",\"main\",[\"network-egress\"]]}" >/dev/null; then
  echo "extension NanoGPT installée (redémarrez le serveur si elle vient d'être ajoutée)"
else
  echo "(extension NanoGPT : voir /tmp/openchar-webui.log)"
fi

cat <<EOF

\033[1;32mPrêt !\033[0m Ouvrez http://127.0.0.1:$PORT
 - le dock chat est le bouton ⌘ en haut à droite
 - « + » crée un onglet = une session Pi (le modèle se choisit dans la barre ⌂)
 - l'agent crée/câble/lance des nodes : demandez, il utilise les outils graph_*
 - clé NanoGPT (optionnelle) : ~/.config/nano-gpt/api_key (chmod 600)
EOF
