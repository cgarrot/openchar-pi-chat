# OpenChar Pi-chat

Un **dock chat à agents** pour [OpenChar Studio](https://github.com/OpenCharAI/OpenChar) : chaque
onglet est une session [Pi](https://github.com/earendil-works/pi-coding-agent) vivante, capable
d'agir sur le canvas (créer/câbler/lancer des nodes), de lire vos fichiers et d'utiliser les
modèles hébergés NanoGPT — en parallèle de vous.

![architecture](https://img.shields.io/badge/architecture-3%20repos-blue)

```
UI ChatDock (fork OpenChar) ── /rpc + WebSocket ── Core (ChatBridge, 1 process pi/onglet)
                                                        └─ extension Pi « openchar » (ce repo)
                                                               └─ outils graph_* → /rpc du Core
Extension NanoGPT (repo inline-nanogpt) ── installée DEPUIS l'app, nodes image/texte/vidéo/audio
```

## Les trois repos — qui fait quoi

| Repo | Rôle | S'installe comment |
|---|---|---|
| **cgarrot/OpenChar** (fork, branche `pi-chat`) | L'app : panneau chat + canaux `chat:*` + selects cherchables | `install-chat.sh` (clone + build du SPA) |
| **cgarrot/openchar-pi-chat** (ce repo) | L'extension Pi : outils `graph_*`, `nanogpt_model_docs`, `chat_set_title`, audit | `install-chat.sh` → `~/.pi/agent/extensions/openchar` |
| **cgarrot/inline-nanogpt** | L'extension OpenChar NanoGPT (232/606/161/85 modèles) | `install-chat.sh` → via l'app (`ext:manage:install`) |

## Installation express

```bash
git clone https://github.com/cgarrot/openchar-pi-chat
cd openchar-pi-chat
bash install-chat.sh     # installe les 3 briques + démarre sur http://127.0.0.1:8848
```

Prérequis : `git`, node ≥ 20, python 3.11+, `pi` installé avec un provider LLM configuré.
Clé NanoGPT (optionnelle, pour les nodes NanoGPT) : `~/.config/nano-gpt/api_key` (chmod 600).

### Installation manuelle (les 3 étapes)

1. **App** : `git clone -b pi-chat https://github.com/cgarrot/OpenChar && cd OpenChar && npm ci && npm run build:spa`, puis `cd core && INLINE_FRONTEND_ROOT=../dist-web ./webui.sh`
2. **Extension Pi** : `git clone https://github.com/cgarrot/openchar-pi-chat ~/.pi/agent/extensions/openchar`
3. **Extension NanoGPT** : dans l'app → Extensions → installer `https://github.com/cgarrot/inline-nanogpt` (accepter `network-egress`), redémarrer

## Utilisation

- **⌘** en haut à droite ouvre le dock ; **+** crée un onglet (= une session Pi persistante)
- **Ⓜ** choisit le modèle (recherche incluse), le menu à côté règle le *thinking* (off → max)
- **Références** (chips en haut) : dossier/fichier persistant injecté dans chaque message
- **Sélection canvas** : chips bleues — ce qui est sélectionné part avec le prochain message
- **📎** images en pièce jointe, **🎯** insère la sélection visiblement, **»** rabat le panneau
  (poignée gauche pour redimensionner), **⧉** copie l'id de session (review/debug)
- L'agent **se nomme tout seul** (« Personnage renard neige NanoGPT »), affiche ses actions en
  cartes (＋ node, ⤳ câbler, ▶ rendre, $ shell), streame sa réponse en markdown
- Bas de panneau : contexte utilisé + coût de la session

### Ce que l'agent peut faire

| Outils | Action |
|---|---|
| `graph_list_nodes` / `graph_list_node_types` | lire le canvas / le catalogue de nodes |
| `graph_add_node` / `graph_add_prompt` / `graph_connect` / `graph_update_node` / `graph_delete` | construire le graphe |
| `graph_run` / `graph_cancel` | lancer / annuler un rendu |
| `nanogpt_list_models` / `nanogpt_model_docs` | catalogues + **schéma de params exact par modèle** |
| `project_info`, `bash`, `read`, `edit`… | contexte projet + outils natifs Pi (accès PC) |

Chaque action est journalisée dans `~/.pi/openchar-audit.jsonl`.

## Dépannage

| Symptôme | Cause / fix |
|---|---|
| Le picker de modèles reste vide | process Pi mort → fermez/rouvrez l'onglet ; voir `/tmp/openchar-webui.log` |
| `HTTP 413` en génération NanoGPT | image de référence trop lourde — corrigé v0.4 (JPEG ≤ 3 Mo auto) |
| L'agent « ne voit » pas le canvas | vérifiez que l'extension est dans `~/.pi/agent/extensions/openchar/index.ts` |
| Pas de streaming | rechargez la page (bundle SPA) — le serveur doit tourner avec `INLINE_FRONTEND_ROOT` |

## Doc architecture

Voir [PLAN.md](PLAN.md) (phases P0–P5, décisions, état d'avancement).
