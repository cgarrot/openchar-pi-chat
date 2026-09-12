#!/usr/bin/env bash
# Démarre OpenChar Core avec le SPA contenant le dock chat Pi (build local dist-web).
cd /home/cgarrot/OpenChar/core
export INLINE_FRONTEND_ROOT=../dist-web
exec bash webui.sh "$@"
