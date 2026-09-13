#!/usr/bin/env bash
# Démarre OpenChar Core avec le SPA contenant le dock chat Pi (build local dist-web).
cd /home/cgarrot/OpenChar/core
export INLINE_RUN_WORKERS="${INLINE_RUN_WORKERS:-3}"
export INLINE_FRONTEND_ROOT=../dist-web
# Supervision: si Core crashe (OOM sous pression mémoire), il revient tout seul.
# INLINE_SUPERVISE=0 pour lancer sans boucle.
if [ "${INLINE_SUPERVISE:-1}" = "1" ]; then
  while true; do
    bash webui.sh "$@"
    code=$?
    [ $code -eq 0 ] && break   # arrêt propre (Ctrl+C)
    echo "[run-with-chat] Core est sorti (code $code) — relance dans 3s…" >&2
    sleep 3
  done
else
  exec bash webui.sh "$@"
fi
