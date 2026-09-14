# Plan améliorations logiciel — d'après la review soap-v2 / bible Trajectoire

Source : review croisée board soap-v2 × ai-film-knowledge × trajectoire (session 2026-09-14).
Objectif : combler les limites logicielles listées pour tenir le process G0→G4.

## P1 — 📌 Épinglage de take (« un étage validé ne se re-rend jamais ») ★ prioritaire
Problème : un aval consomme toujours le DERNIER take ; impossible de figer le meilleur.
- `data.core.pinnedTakeId` sur l'item : le take épinglé devient **la** sortie de la node.
- Le gel à la construction (`_latest_output_freeze`) utilise le take épinglé (défaut : dernier).
- Une node épinglée **ne se re-render jamais**, même en cible de run (il faut désépingler
  explicitement pour itérer) — implémentation littérale de la règle d'or des gates.
- Outils agent : `graph_pin_take(itemId, takeId)` / `graph_unpin_take(itemId)`.
- UI (v2) : 📌 sur les vignettes d'historique + badge sur la node.

## P2 — 👁️ QC vision sur les takes (G0/G1/G4 automatisables)
Problème : pas de node QC ; l'agent « compense » hors canvas.
- Outil agent `take_qc(filePath|takeId, checklist)` : envoie l'image au modèle **vision**
  NanoGPT (sélection auto dans le catalogue détaillé : input_modalities ⊇ image) et renvoie
  les constats texte (façades présentes ? identité ? tenue ? continuité).
- Permet Gate 0 (masters vs Bloc A/B/D), Gate 1 (keyframes), Gate 4 (clips) sans quitter le chat.

## P3 — 🌱 Seed vidéo (seedance)
Vérifier si l'API expose `seed` pour seedance-2.5 (catalogue détaillé). Si oui : notre node
l'envoie déjà (seed ≥ 0) → documenter. Si non : corriger la bible (dérive doc), la
reproductibilité vidéo passe par le verrou d'image de départ (déjà le cas).

## P4 — 🔇 Piège generate_audio
Le défaut du modèle est `true` (coût + voix parasite). Notre node default False, mais
l'agent l'a activé sur les 12 vidéos en suivant la fiche modèle.
- Label du param : « Audio soundtrack (⚠ coût — OFF si sound design en post) ».
- Skill : règle explicite « vérifie la bible avant d'activer l'audio intégré ».

## P5 — 🎬 Export CLIPS pour le montage
L'agent génère le `CLIPS=` de build_minute01.sh à la main → outil
`graph_export_clips()` : paths absolus des takes actifs (épinglés sinon derniers), triés
par position canvas, formatés en tableau shell prêt à coller.

## P6 — 🗂️ Organisation visuelle des étages
56+ items → grouper par étage rend la linéarité visible.
- v1 : skill — l'agent crée des Layers (moodboard:addLayer) par étage G0→G4 / par minute ;
  ✨tidy déjà range par profondeur topologique.
- v2 (plus tard) : « frames » visuelles titrées.

## P7 — 🎵 Entrée audio sur les nodes vidéo (optionnel, à valider)
reference_audios n'accepte que des URLs ; tester si data-URLs passent avant d'ajouter un
port audio. Le sound design reste en post de toute façon (storyboard).

## Non-logiciel (rappels)
- Les fixes du board (câbler la sheet sur PL06/PL08, etc.) = travail de l'AGENT, pas du
  logiciel — la review les a listés, dire « go » à l'agent les exécute.
- Characters nodes pour la minute 2 : à tester via l'agent (rien à coder).

## Ordre
P1 → P2 → P5 (ce tour) ; P3/P4 vérifs rapides ; P6 skill ; P7 en attente de validation API.
