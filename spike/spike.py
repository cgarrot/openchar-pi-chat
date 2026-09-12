#!/usr/bin/env python3
"""Spike P0 : pont Python vers une session Pi en mode RPC + test des outils graphe openchar.

Usage: python3 spike.py "ajoute un node z-image sur le canvas"
Sans argument, envoie une demande de démonstration (créer un node + un prompt + les câbler).
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

PI = "/home/cgarrot/.local/share/pi-node/node-v22.23.2-linux-x64/bin/pi"
SESSION_DIR = Path("/home/cgarrot/openchar-pi-chat/sessions")
SESSION_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_PROMPT = (
    "Utilise les outils openchar : 1) liste les types de nodes disponibles, "
    "2) ajoute un node 'alibaba/z-image-turbo' à la position (500, 300), "
    "3) ajoute un item prompt à (200, 320) avec le texte "
    "'a lighthouse on a cliff at stormy dusk, cinematic', "
    "4) câble la sortie du prompt vers l'entrée prompt du node z-image. "
    "Donne-moi les ids créés."
)


def fmt(event: dict) -> str:
    t = event.get("type", "?")
    if t == "message_update":
        d = event.get("assistantMessageEvent", {}) or {}
        kind = d.get("type", "")
        if kind == "text_delta":
            return f"  δ {d.get('delta', '')}"
        if kind == "tool_call":
            return f"  ⚒ tool_call: {json.dumps(d.get('toolCall', d))[:220]}"
        return f"  · message_update/{kind}"
    if t in ("tool_execution_start", "tool_execution_end"):
        name = event.get("toolName", "?")
        arg = json.dumps(event.get("input", event.get("result", "")))[:160]
        return f"⚒ {t}: {name} {arg}"
    if t == "agent_start":
        return "▶ agent_start"
    if t in ("agent_end", "agent_settled"):
        return f"■ {t}"
    if t == "response":
        return f"✓ response/{event.get('command')} success={event.get('success')}"
    if t == "extension_error":
        return f"‼ extension_error: {json.dumps(event)[:400]}"
    if t == "error":
        return f"‼ error: {json.dumps(event)[:300]}"
    return f"· {t}: {json.dumps(event)[:160]}"


async def main() -> None:
    prompt_text = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROMPT
    proc = await asyncio.create_subprocess_exec(
        PI, "--mode", "rpc", "--name", "openchar-spike",
        "--session-dir", str(SESSION_DIR),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdin and proc.stdout

    async def send(command: dict) -> None:
        proc.stdin.write((json.dumps(command) + "\n").encode())
        await proc.stdin.drain()

    async def reader(tag: str, stream: asyncio.StreamReader) -> None:
        while True:
            line = await stream.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").strip()
            if not text:
                continue
            if tag == "OUT":
                try:
                    print(fmt(json.loads(text)), flush=True)
                except json.JSONDecodeError:
                    print(f"  (brut) {text[:200]}", flush=True)
            else:
                print(f"  [stderr] {text[:200]}", flush=True)

    out_task = asyncio.create_task(reader("OUT", proc.stdout))
    err_task = asyncio.create_task(reader("ERR", proc.stderr))

    await asyncio.sleep(3)  # laisse l'extension charger
    await send({"id": "s0", "type": "get_state"})

    print(f"\n>>> PROMPT: {prompt_text[:120]}...\n", flush=True)
    await send({"id": "s1", "type": "prompt", "message": prompt_text})

    # attend la fin de l'agent (agent_settled / agent_end) avec timeout global
    try:
        await asyncio.wait_for(out_task, timeout=600)
    except asyncio.TimeoutError:
        print("⏱ timeout — abort", flush=True)
        await send({"type": "abort"})
        await asyncio.sleep(3)

    err_task.cancel()
    try:
        proc.terminate()
    except ProcessLookupError:
        pass
    await proc.wait()


if __name__ == "__main__":
    asyncio.run(main())
