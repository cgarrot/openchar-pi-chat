# Plan — intégrer ai-film-knowledge dans OpenChar + le chat agent

Base : `/home/cgarrot/zob/ai-film-knowledge` (state graph, 4 mémoires, compilateurs
prompt/camera, grilles QC, 3 skills pi, capability registry, EVIDENCE-LEDGER).
Objectif : que le système complet (canvas + agent + knowledge) tourne comme le prescrit la
ROADMAP — le film est un **graphe d'états**, le canvas en est l'exécution, l'agent est le
directeur de production IA, la base est la mémoire longue.

## Ce qui fonctionne déjà (à ne pas refaire)
- Les 3 skills (`ai-film-director`, `ai-film-qc`, `ai-film-case-analyzer`) sont symlinkés
  dans `~/.pi/agent/skills/` → l'agent du chat y accède déjà.
- Les outils `compile_prompt.py` / `compile_camera.py` / `qc_report.py` sont exécutables via
  bash par l'agent.
- Les gates G0→G4 + pin take (logiciel, livré) implémentent l'execution-plan.
- Le chat a la mémoire de session + refs deep (le repo en ref deep = connaissance injectée).

## A1 — 🔌 `take_qc` branché sur les grilles QC du repo ★ rapide
`take_qc` accepte aujourd'hui une checklist libre → lui faire accepter un nom de grille
(`--grid identity|continuity|motion|cinematic`) lu depuis
`tools/qc_checklists.yaml` (chemin via env `AIFILM_KB`). L'agent QC avec les grilles
canoniques, pas du free-text.
**Effort : 30 min.**

## A2 — 🧠 Mémoire film par projet (la 4e mémoire vit DANS le projet)
Convention : `<projet>.inlinestudio/film-memory.yaml` (mémories production sérialisées du
template `projects/_template/`). L'agent la lit/écrit avec ses outils fichier — elle suit
les **onglets projet** automatiquement.
- Skill `openchar-pipelines` : règle « au premier message d'un projet, lis film-memory.yaml ;
  à chaque gate validée, mets-la à jour (états, décisions, seeds) ».
- `projects/soap-v2/` dans le KB reste la version « publiée » (copie manuelle).
**Effort : skill seul, 20 min.**

## A3 — 🗺️ Le canvas AFFICHE le state graph (vues par étage)
- Tidy ✨ existe (layout topologique). Ajouter : l'agent crée des **Layers** nommés
  `G0-masters`, `G1-keyframes`, `G2-pilote`, `G3-batch`, `G4-QC` (moodboard:addLayer) et y
  range les nodes — la linéarité devient visible (demande de la review).
- v2 : un champ `data.core.stateRef` (id FILM_STATE) affiché comme badge sur la node —
  pont canvas ↔ YAML mémoire.
**Effort v1 : skill, 10 min. v2 : logiciel, 2-3 h.**

## A4 — 🎯 `nanogpt_pick_model(capability)` — routing par registry
Le capability registry (`models/capability-registry.md`, daté, corrobéré) dit quel modèle
pour quelle capability (identity-lock, audio-off, camera-language…). Outil agent qui croise
registry × catalogue NanoGPT détaillé → recommande + explique (pourquoi, depuis quand,
corroboration EVIDENCE-LEDGER).
**Effort : 1-2 h.**

## A5 — 🧾 Générateur d'execution-plan depuis le storyboard
`plan_from_storyboard(storyboard.md)` : l'agent (skill director) produit le plan G0→G4
pré-rempli (carriers identifiés, keyframes par plan, routing modèle par capability, budget
estimé depuis les fiches) et le pose en `execution-plan.yaml` dans le projet. Revient au
pattern « announce the plan BEFORE building » — maintenant outillé.
**Effort : skill + prompt, 1 h.**

## A6 — 📊 QC automatique post-render (gate 4 en boucle)
Hook logiciel : quand un take atterrit sur une node vidéo, proposer (event) à l'agent de
lancer `take_qc --grid motion` sur la première frame + rappel grille motion. v1 : règle de
skill (« après chaque batch vidéo, QC systématique, rapport dans film-memory »).
**Effort v1 : skill. v2 (auto-trigger) : logiciel, 3-4 h.**

## A7 — 🎬 Montage : au-delà de CLIPS=
`graph_export_clips` livré. Suite possible :
- export **EDL/OTIO** (ordre + durées + trims) pour import Premiere/Resolve ;
- node canvas « Timeline » qui pré-visualise la minute assemblée depuis les takes épinglés.
**Effort : 1 j (OTIO) / 2-3 j (node timeline). À planifier après minute 1.**

## A8 — 📈 EVIDENCE-LEDGER alimenté automatiquement
Chaque pipeline exécutée (pattern mobilisé, modèle, pass/fail QC) devrait incrémenter le
ledger. Outil agent `ledger_record(pattern, model, outcome)` qui édite le fichier MD —
la base apprend de CHAQUE run OpenChar, pas seulement des cases X.
**Effort : 1-2 h.**

## A9 — 🧪 Experimental loop intégrée
`production/experimental-loop.md` (une variable par itération, archivage des essais) →
les takes historiques + pin + fork chat en sont déjà les briques. À formaliser dans le
skill : « itérer = dupliquer la node (graph tools) + UNE variable + comparer via take_qc ;
l'essai rejeté reste dans l'historique de takes ».
**Effort : skill, 20 min.**

## Priorisation
1. **A1 + A2 + A3-skill + A9** (une seule session : tout skill/tools légers, gros effet)
2. **A4 + A5** (routing + planning outillés)
3. **A6-v1** (QC systématique)
4. **A8** (ledger auto)
5. **A7, A3-v2, A6-v2** (gros logiciel, après minute 1 validée)

## Non-objectifs (pour l'instant)
- Refaire les compilateurs du KB dans le canvas (bash suffit).
- Node QC canvas-native (take_qc via l'agent couvre).
- Lip-sync / audio canvas (sound design reste en post, conforme storyboard).
