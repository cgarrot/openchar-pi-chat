# OpenChar × Pi — Panneau chat agent intégré : plan détaillé

> Objectif : un panneau chat latéral dans OpenChar Studio, avec **onglets multiples**, chaque onglet
> étant une **session Pi** vivante. L'agent peut **manipuler le graphe** (créer des nodes/fenêtres,
> câbler des liens, lancer des générations), recevoir des **références** (images, dossiers, sélection
> courante) et a **accès au PC** (fichiers, shell) dans les limites qu'on lui fixe.

---

## 0. Ce qui existe déjà (inventaire vérifié dans le code)

| Brique | État | Où |
|---|---|---|
| Frontend SPA | React 19 + zustand + @xyflow/react (canvas) + react-resizable-panels + Vite | `src/renderer/` |
| Bus frontend↔Core | `POST /rpc` (`{channel, args}`) + WebSocket `/events` (frames `{channel, payload}`) | `src/renderer/lib/webClient.ts`, `core/src/inline_core/server/app.py` |
| Manipulation du graphe (côté serveur) | Canaux déjà présents : `moodboard:list`, `addCoreNode(type,x,y)`, `addPrompt`, `updateItem(iid,patch)`, `deleteItem`, `createConnector(from,to,sh,th)`, `deleteConnector`, `replaceBoard`, `generation:runWorkflow(item_id)`, `generation:cancel`, `core:models` | `core/src/inline_core/studio/handlers.py` |
| Assets/images | `POST /v1/assets` (upload binaire → id), `assets:*`, `frames:*` | idem |
| Pi pilotable | SDK TS (`createAgentSession` + `customTools` via `defineTool`) **ou** mode RPC headless (`pi --mode rpc`, JSONL sur stdio, prompt avec images, événements en flux) | `docs/sdk.md`, `docs/rpc.md` du paquet pi |
| Sessions Pi persistantes | fichiers de session, resume, fork, compaction | `docs/sessions.md` |

**Conséquence clé** : ~80 % de la surface « actions graphe » existe déjà côté serveur. Le travail
principal est (1) le pont Pi↔Core, (2) le panneau UI, (3) la couche outils/outillages de l'agent.

---

## 1. Architecture cible

```
┌─────────────────────────── OpenChar Studio (navigateur) ───────────────────────────┐
│  Canvas (Moodboard/xyflow)                     Panneau Chat (nouveau, dock droite)  │
│        ▲ updates via /events                          │ onglets [A][B][+]           │
│        │                                              │ messages, cartes d'outils,   │
└────────┼──────────────────────────────────────────────┼─────────────────────────────┘
         │ WebSocket /events                             │ WS /events (canal chat:*) + /rpc
┌────────┴──────────────────────────────────────────────▼─────────────────────────────┐
│                        Inline Core (Python, FastAPI) — inchangé + module chat        │
│   chat:* (nouveaux canaux) : tabs list/create/close/rename, prompt, cancel, attach   │
│   ChatBridge : 1 processus `pi --mode rpc` par onglet (spawn/resume/kill, JSONL)     │
│   persistance : <projet>/.pi-chat/tabs.json + sessions pi dans <projet>/.pi-chat/    │
└──────────┬───────────────────────────────────────────────────┬──────────────────────┘
           │ stdio JSONL (prompt, events)                      │ HTTP POST /rpc local
┌──────────▼───────────────────────┐               ┌───────────▼──────────────────────┐
│  Pi (pi --mode rpc) par onglet   │               │  Extension Pi « openchar » (TS)  │
│  outils natifs : read, bash,     │               │  pi.registerTool : graph_list,   │
│  edit, write, grep… (accès PC)   │               │  graph_add_node, graph_connect,  │
│  + extension openchar ↓          │               │  graph_update, graph_run, …      │
└──────────────────────────────────┘               │  → appelle Core /rpc existant    │
                                                   └──────────────────────────────────┘
```

Pourquoi ce découpage :
- **Pi en mode RPC subprocess** plutôt que SDK in-process : Core est Python, le SDK Pi est
  TypeScript/Node. Le mode RPC est le pont officiel headless (JSONL stdio), langage-agnostique,
  avec events en flux et images en prompt. Pas de second service Node à maintenir.
- **L'extension Pi** donne à l'agent ses pouvoirs « graphe » en appelant les canaux `/rpc` **déjà
  existants** de Core : zéro nouvelle surface serveur pour les actions, la même source de vérité
  que l'UI.
- **Les onglets = sessions Pi persistantes** (un fichier de session par onglet, resumables après
  reload/restart). Le contexte de chaque onglet survit.

---

## 2. Décisions structurantes (à valider avant de coder)

### D1 — Où vit le panneau ? → patch du frontend (dans notre clone), pas une extension
Le système d'extensions OpenChar n'ajoute que des **nodes** et des canaux RPC, pas d'UI : le SPA
est prébuildé. Deux options :
- **A (recommandé) : intégrer le panneau dans `src/renderer`** (notre clone), build local
  (`npm run build:spa` → servi via `INLINE_FRONTEND_ROOT=../dist-web`). propre, intégré au
  layout (react-resizable-panels), thèmes ; coût : maintenir le patch à chaque MAJ upstream
  (mitigeable en gardant le diff minéralisé : 1 vue + 1 mount + N fichiers nouveaux).
- B : micro-frontend séparé (iframe overlay injecté) — zéro diff sur le SPA, mais UX dégradée
  (pas d'accès direct au store zustand/sélection), on ne le retient que si A bloque.

### D2 — Quel modèle de session par onglet ?
- 1 onglet = 1 session Pi (`--session-dir <projet>/.pi-chat/sessions`), cwd = dossier du projet
  (ou `$HOME` si aucun projet ouvert — à confirmer).
- Nom d'onglet = `--name` de la session. `chat:tabs` liste/resume à froid.

### D3 — Droits de l'agent sur le PC
- Par défaut : `read` + `bash` + `edit` de Pi, cwd = projet → accès réel au PC (demande explicite
  du user). Prévoir un réglage par onglet : « PC complet (home) » / « Projet seul » /
  « Graphe seul (sans bash) » (tools: `graph_*` uniquement).
- Kick-off : les commandes bash destructives (`rm`, `git push`…) restent sous la responsabilité
  de Pi ; on ajoute une bannière claire + kill-switch par onglet.

### D4 — Modèle LLM de Pi
- Config provider via env existant de Pi (ANTHROPIC_API_KEY / OPENAI_API_KEY / Ollama…),
  sélectionnable par onglet à la création (`chat:createTab(model=…)`) avec défaut dans Settings.
- On peut aussi réutiliser la clé nano-gpt (API OpenAI-compatible) comme provider Pi —
  « openai-compatible base url nano-gpt » — bonus sympa à documenter.

---

## 3. Composants à construire

### C1 — `ChatBridge` côté Core (Python) — le cœur
Nouveau module `core/src/inline_core/studio/chat.py` (~400 lignes) + enregistrement dans
`handlers.py` :

| Canal | Args | Rôle |
|---|---|---|
| `chat:tabs` | — | liste des onglets (id, titre, modèle, état, dernier message) |
| `chat:createTab` | `{title?, model?, cwd?, tools?}` | spawn `pi --mode rpc --session-dir …` ; renvoie l'id |
| `chat:closeTab` | `tabId, {kill?}` | arrête le process (et/ou garde la session pour resume) |
| `chat:renameTab` | `tabId, title` | renomme (persisté) |
| `chat:prompt` | `tabId, message, {images?: [assetId\|b64], refs?: {frameIds, nodeIds, folder}}` | envoie la commande `prompt` au process ; les images en base64 (pi les accepte nativement) |
| `chat:cancel` | `tabId` | abort du run en cours |
| `chat:history` | `tabId` | rejoue l'historique rendu (messages + tool calls) après reload |

Fonctionnement interne :
- Gestion process : `asyncio.create_subprocess_exec` avec stdio pipé, lecture ligne à ligne
  (découpage strict sur `\n`), TTL d'inactivité configurable, kill propre (SIGTERM→SIGKILL),
  respawn/resume automatique si un onglet est sollicité après un restart de Core.
- Traduction des **événements RPC Pi** (text_delta, tool_call, tool_result, done, error…) en
  frames `{channel: "events:chat", payload: {tabId, …}}` diffusées sur le WebSocket `/events`
  existant → le panneau n'a **rien** de nouveau à câbler côté transport.
- Références « dossiers » : on n'upload rien ; on injecte dans le prompt un contexte structuré
  (chemin + listing arborescent limité via `os.walk` borné en profondeur/nœuds) + l'agent explore
  ensuite avec ses outils natifs (read/bash/grep). Option « importer comme assets » à part.
- Persistance : `<projet>/.pi-chat/tabs.json` (onglets, titres, modèle, droits) — les messages
  vivent dans les fichiers de session Pi, on ne les duplique pas.

### C2 — Extension Pi `openchar` (TypeScript) — les outils graphe
`~/.pi/agent/extensions/openchar/` (ou `.pi/extensions/` du projet), un seul fichier :

| Otool Pi | Params | Derrière quel canal Core |
|---|---|---|
| `graph_list_nodes` | — | `moodboard:list` (+ `core:models` pour les types dispo) |
| `graph_add_node` | `type, x, y` | `moodboard:addCoreNode` (types NanoGPT inclus !) |
| `graph_add_prompt` | `text, x, y` | `moodboard:addPrompt` |
| `graph_connect` | `from, to, sourceHandle?, targetHandle?` | `moodboard:createConnector` |
| `graph_update_node` | `itemId, patch` | `moodboard:updateItem` (params, position) |
| `graph_delete` | `itemId \| connectorId` | `moodboard:deleteItem` / `deleteConnector` |
| `graph_run` | `itemId` | `generation:runWorkflow` (rend le node/la fenêtre) |
| `graph_cancel` | `itemId` | `generation:cancel` |
| `graph_screenshot` | — | `moodboard:list` re-rendu en SVG/minimap (v2 : thumbnail PNG) |
| `asset_upload_path` | `path` | lit le fichier local → `POST /v1/assets` → id utilisable en input |
| `project_info` | — | `project:current`, `frames:list` (contexte rapide) |

Détails :
- Chaque outil fait un `fetch("http://127.0.0.1:8848/rpc", {channel, args})` — l'URL du Core est
  passée à l'extension par env (`INLINE_CORE_URL`) au spawn.
- Après chaque action mutante, l'outil renvoie à Pi un résumé + l'id créé, et l'UI reçoit
  l'update par `/events` comme si l'utilisateur avait cliqué : **une seule source de vérité**.
- Les schemas des params (typebox) reprennent les signatures exactes des lambdas de
  `handlers.py` (déjà vérifiées).

### C3 — Panneau UI (React) — `src/renderer/views/Chat/`
Nouveaux fichiers (aucun fichier existant modifié sauf montage + layout) :
- `ChatPanel.tsx` — dock droite (`react-resizable-panels`), repliable, raccourci `Ctrl+L`.
- `ChatTabs.tsx` — barre d'onglets (+/close/rename), état par onglet (idle/streaming/error).
- `ChatMessageList.tsx` — messages user/assistant, markdown, **images inline** (glisser une image
  = upload asset + prompt avec image), cartes d'outils repliables : `bash ▸ commande + sortie`,
  `graph ▸ + node nanogpt/image (krea-2/turbo) @ (x,y)`, `edit ▸ fichier` avec diff.
- `ChatComposer.tsx` — textarea multi-ligne, boutons : 📎 image, 📁 dossier, 🎯 « envoyer la
  sélection » (nodes/fenêtres sélectionnés sur le canvas), modèle/thinking par onglet, Stop.
- `useChat.ts` (hook zustand) — état onglets/messages, souscrit `events:chat` via le
  `webClient.ts` existant, appels `chat:*` via le client RPC existant.
- Intégration : `App.tsx` (+1 `<Panel>`) et `mountStudioApp` — diff minimal de ~20 lignes.

### C4 — Références & contexte
- **Image(s)** : drag&drop ou 📎 → `POST /v1/assets` → envoyée en prompt-image Pi (base64) ET
  posable sur le canvas en un clic depuis la bulle.
- **Dossier** : 📁 → chemin (input natif `showDirectoryPicker` ou champ texte) → contexte
  arborescent injecté + l'agent navigue avec read/bash.
- **Sélection canvas** : 🎯 sérialise les nodes sélectionnés (type + params + connexions) dans
  le prompt — l'agent « voit » le graphe courant sans outil.
- **Auto-contexte léger** à chaque prompt : nom du projet, vue active, nombre de nodes (1 ligne).

### C5 — Sécurité & garde-fous
- Core écoute sur 127.0.0.1 (déjà le défaut) ; les canaux `chat:*` refusent toute origine non
  locale (middleware simple).
- Réglages (Settings, persistés) : droits par défaut d'un nouvel onglet, budget max tokens/prompt
  (passé à Pi), TTL d'inactivité des process, kill-switch global.
- Les actions graphe de l'agent passent par les mêmes canaux que l'UI : pas de bypass, l'annulation
  `generation:cancel` fonctionne pour lui aussi.
- Audit : journal local `<projet>/.pi-chat/audit.jsonl` (1 ligne par action outil graphe).

---

## 4. Phases de réalisation (chacune livrant un truc utilisable)

| # | Contenu | Livrable vérifiable | Effort |
|---|---|---|---|
| **P0 — Spike pont RPC** ✅ fait (validé : node créé par l'agent) | Script Python qui spawn `pi --mode rpc`, envoie un prompt, streame les deltas ; extension Pi `openchar` avec `graph_list_nodes` + `graph_add_node` qui tapent `/rpc` | Terminal : « ajoute un node Z-Image en (400,300) » → le node apparaît dans l'UI ouverte | 1–2 j |
| **P1 — ChatBridge Core** ✅ fait (chat:*, events:chat, tabs persistés, respawn) | Module `chat.py` + canaux `chat:*` + events `/events` + tabs.json ; testé au curl | `chat:createTab` + `chat:prompt` en curl, deltas visibles sur le WS | 2–3 j |
| **P2 — Panneau UI v1** ✅ fait (dock, onglets, streaming, cartes outils, images) | ChatPanel + onglets + composer + streaming markdown + cartes outils basiques | Chat utilisable dans l'app, onglets persistants après reload | 3–4 j |
| **P3 — Références** ✅ fait (images 📎, dossier 📁 avec arborescence injectée, sélection canvas 🎯) | Images (asset + prompt-image), dossiers (contexte arbo), sélection canvas, asset_upload_path | « Génère-moi ça à partir de ~/photos/ref » fonctionne | 2–3 j |
| **P4 — Outils graphe complet** ✅ fait (connect/update/delete/run/cancel dans l'extension) | connect/update/delete/run/cancel + runWorkflow piloté par l'agent + cartes riches | « Monte-moi un pipeline prompt→NanoGPT image→upscale et lance-le » | 2–3 j |
| **P5 — Sécurité & polish** ⬜ à faire (settings droits/budget/TTL, audit, thumbnails) | Settings droits/budget/TTL, audit, respawn/resume, thumbnails canvas, i18n FR | Finitions, doc utilisateur | 2 j |

**Total estimé : ~12–17 jours** pour la v1 complète ; le spike P0 valide l'architecture en
une journée.

## 5. Risques & points d'attention
1. **Framing JSONL strict** du mode RPC Pi (découper sur `\n` uniquement, pas de readline générique) — piège documenté.
2. **Dérive du canvas** : positions x,y auto quand l'agent crée sans coordonnées (auto-layout simple : grille à droite du dernier node).
3. **Concurrence** : deux onglets qui mutent le graphe en même temps → les canaux moodboard:* sont déjà séquentiels côté Core (store SQLite par projet), OK ; l'UI se resynchronise via /events.
4. **MAJ upstream du SPA** : garder le diff frontend minéralisé (vue isolée + hook) pour rebase facile.
5. **Coût/clés** : le modèle Pi par défaut doit exister (env provider) sinon message clair à la création d'onglet.
6. **Accès PC** : assumé (demande utilisateur), mais réglage « graphe seul » disponible + bannière explicite par onglet.

## 6. Ordre de démarrage concret (P0, jour 1)
1. `core/src/inline_core/studio/chat/spike.py` : spawn `pi --mode rpc --session-dir /tmp/pi-spike`,
   prompt « liste les fichiers du cwd », affichage des deltas.
2. `~/.pi/agent/extensions/openchar/index.ts` : `graph_list_nodes` + `graph_add_node` →
   `fetch(INLINE_CORE_URL + '/rpc')`.
3. Prompt au spike : « ajoute un node alibaba/z-image-turbo sur le canvas » → vérifier dans
   l'UI ouverte (http://127.0.0.1:8848) que le node apparaît en temps réel.
4. Si OK → P1 dans la foulée.


---

## 7. État d'avancement (session du 12/09)

- **P0 ✅** — spike validé : l'agent Pi crée nodes/prompts/câblages via l'extension `openchar`.
- **P1 ✅** — `core/src/inline_core/studio/chat.py` (ChatBridge) + canaux `chat:*` + frames
  `events:chat` ; onglets persistés dans `<app-data>/chat/tabs.json`, respawn automatique validé.
- **P2 ✅** — `src/renderer/store/chatStore.ts` + `views/Chat/ChatPanel.tsx` + namespace `chat`
  dans `src/shared/ipc.ts` ; dock dans `Workspace.tsx` ; build servi via `INLINE_FRONTEND_ROOT`.
- **P4 ✅** — tous les outils graphe sont dans `~/.pi/agent/extensions/openchar/index.ts`.
- **P3 ✅** — 📁 dossier (arborescence bornée préfixée au message, validé : l'agent liste puis explore avec bash), 🎯 sélection canvas sérialisée dans le draft.
- **Fix UI** — boucle React #185 (sélecteur zustand qui recréait un [] vide) corrigée, bundle reconstruit.
- **NanoGPT v0.3.0** — node vidéo enrichi depuis les schémas détaillés du catalogue :
  aspect_ratio, generateAudio, enable_prompt_expansion, enable_web_search, entrée « image de fin » (last_image).
- **Reste (P5)** : settings sécurité/budget par onglet, audit jsonl, stats tokens/coût, thumbnails canvas, tests UI navigateur manuels.

### Démarrage avec l'UI modifiée
```bash
cd /home/cgarrot/OpenChar/core
INLINE_FRONTEND_ROOT=../dist-web ./webui.sh     # ou ./run-with-chat.sh (wrapper)
```
Sans `INLINE_FRONTEND_ROOT`, le serveur sert l'UI pip d'origine (sans le dock chat).
