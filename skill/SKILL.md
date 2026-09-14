---
name: openchar-pipelines
description: "Recette pour construire ET exécuter des pipelines de génération sur le canvas OpenChar (design de personnage en 3 étages : études → fusion → vues). Utilise les outils graph_* avec graph_run en mode wait pour dérouler toute la chaîne, vérifier les takes avec graph_item_info et diagnostiquer avec activity_recent. À utiliser dès que l'utilisateur demande une pipeline de génération d'images (design de personnage, sheets, turnaround, variantes) sur OpenChar."
---

# Pipelines de génération OpenChar

Quand l'utilisateur demande une pipeline de génération (ex. design de personnage :
études → fusion → vues), **construire n'est que la moitié du travail** : il faut aussi
**exécuter la pipeline jusqu'au bout** et vérifier chaque étage. L'utilisateur regarde le
canvas en direct et attend des images, pas un schéma.

## Le pattern en 3 étages (design de personnage)

```
[prompt visage]──▶[étude visage]──┐
[prompt corps]───▶[étude corps]───┼─▶[prompt fusion]──▶[FUSION]──┬─▶[turnaround]
[prompt costume]─▶[étude costume]─┘        (edit)               ├─▶[expressions]
                                                                 └─▶[action/variante]
```

1. **Études** : nodes `nanogpt/image` avec un modèle **text-to-image**, un prompt par sheet
   (visage, corps/corpulence, costume). Aspect ratio par sheet (2:3 portrait, 3:2 costume).
2. **Fusion** : node `nanogpt/image` avec la variante **edit** du même modèle. Câbler la
   sortie **de chaque étude** vers l'entrée `image` de la fusion (une image de référence
   par câble — toutes partent dans la requête). Le prompt de fusion dit quoi prendre de
   chaque sheet (« prend le visage de la réf 1, la silhouette de la réf 2… »).
3. **Vues** : nodes `edit` alimentés par la sortie **image de la fusion** + leur prompt
   (turnaround 4 angles, feuille d'expressions, action shot…).

## Exécution — la partie que l'on oublie

Le moteur exécute **toute la chaîne amont d'un node dans l'ordre** (avec cache des nodes
déjà rendus). Donc :

1. `graph_run` sur le **node FINAL** (la dernière vue) avec `wait: true` — études, fusion
   puis vues s'enchaînent automatiquement. Timeout généreux (600-900 s pour 6+ nodes).
2. À la fin : `graph_item_info` sur la fusion et une vue pour **vérifier les takes**
   (`outputs[].takeId`). Pas de take = échec → `activity_recent` pour l'erreur.
3. En cas d'échec : corriger avec `graph_update_node` (params/prompt — cf.
   `nanogpt_model_docs` pour les params exacts du modèle) puis relancer `graph_run`.
4. Résumé final : ce qui a été rendu (nb de takes par étage), ce qui reste.

## Pièges connus

- **Câblage** : les handles sont auto-remplis pour le cas simple (prompt → unique entrée
  texte ; sortie standard d'une source core), mais explicite-les dès qu'il y a ambiguïté
  (`targetHandle: "image"` sur une fusion, `sourceHandle: "image"` depuis un générateur).
- **Cache et crédits** : les nodes déjà rendus sont réutilisés tant que le serveur tourne.
  Après un **redémarrage du serveur**, ne relance jamais une node aval sans vérifier ses
  amonts (`graph_item_info` : des `outputs` existent ?) — et de façon générale, lance les
  étages d'une même session sans redémarrer entre eux.
- Les prompts d'études décrivent UNE sheet chacun ; celui de fusion **réfère aux images
  câblées** et impose « exactly the same woman » pour les vues.
- `aspect_ratio` se règle par node (2:3 portrait, 16:9 turnaround, 1:1 expressions).
- Un node sans take après un run = erreur : regarde `activity_recent`, pas le silence.
- N'ajoute jamais de nodes non demandés ; annonce le plan (une liste courte) avant de
  construire, puis construis et exécute.
- **Attente** : préfère la vérification par `graph_item_info` après un `sleep` bash plutôt
  que des re-runs ; les rendus d'un même étage peuvent tourner en parallèle côté serveur.


## Gates de validation (G0→G4) — process linéaire

- **G0** masters validés (take_qc contre les blocs bible) → **épingler** (`graph_pin_take`) :
  une node épinglée ne se re-rend jamais, c'est la gate.
- **G1** keyframes : take_qc une par une (façades, identité, tenue, continuité). FAIL =
  delta-edit du node fautif SEUL, jamais des voisines. Valide → épingler.
- **G2** vidéo pilote sur LE plan le plus dur, rendue seule, regardée entière, UNE variable
  changée par itération.
- **G3** batch des autres (un seul passage, tout est câblé et les amonts épinglés sont gelés).
- **G4** QC des clips → `graph_export_clips()` pour générer le CLIPS= du script de montage.

## Règles satellites

- `generate_audio` : le DÉFAUT du modèle est true (coût + voix parasite). Ne l'active que si
  la bible le demande explicitement (sound design en post = OFF).
- Vidéo `seedance-2.5` / `-turbo` : pas de seed côté API (seul `-spicy` en a un) — la
  reproductibilité passe par le verrou d'image de départ (keyframe épinglée).
- Multi-identités (minute 2+) : préférer les nodes character/* (encode + verify-refs + .char)
  aux sheets ré-injectées — à tester d'abord sur un personnage.
- Range le board par étages (moodboard:addLayer « G0-Masters », « G1-Keyframes », …) : la
  linéarité doit se VOIR.


## Mémoire film par projet (A2)

Chaque projet porte sa mémoire : `<chemin du projet>/film-memory.yaml` (le chemin est dans le
tampon `[Projet actif : … — chemin]` de chaque message). Au premier message d'un projet :
lis-la si elle existe. À chaque gate validée, décision prise, seed notable : mets-la à jour
(états du film, carriers épinglés, routages, échecs retenus). C'est la mémoire longue que la
session seule ne peut pas porter — elle survit aux chats.

## Le canvas montre le process (A3)

Range le board par étages visibles : crée un Layer par étage (`moodboard:addLayer`, renomme
via `graph_update_node` → `data.name`) : « G0-Masters », « G1-Keyframes », « G2-Pilote »,
« G3-Batch », « G4-QC » — et positionne-le autour des nodes de son étage (le layer est un
rectangle ; ce qu'il entoure, c'est son contenu). La linéarité doit se VOIR sur le board.

## Boucle expérimentale (A9)

Itérer sur un rendu = **dupliquer la node** (même type/params, position décalée), changer
**UNE seule variable** (prompt, ratio, modèle), re-render, comparer avec `take_qc`, garder le
meilleur (pin) — l'essai rejeté reste dans l'historique de takes, rien ne se perd. Ne modifie
JAMAIS la node validée elle-même : c'est l'esprit de l'experimental loop du KB.


## Depuis le storyboard → execution-plan (A5)

À la demande « crée la pipeline depuis le storyboard » :
1. Lis le storyboard + la bible du projet (dossier trajectoire ou refs) ET les 4 mémoires
   templates du KB (`projects/_template/*.yaml`) comme structure.
2. Produis `<projet>/execution-plan.yaml` : étages G0→G4, par plan : carriers requis,
   keyframe spec (prompt court), routing modèle PAR CAPABILITY (`nanogpt_pick_model`, jamais
   un nom en dur), budget estimé (fiches modèles), critères QC par gate.
3. Annonce le plan (résumé court) AVANT de construire — puis construis étage par étage.

## QC systématique post-batch (A6)

Après chaque batch de rendus (étage G1 keyframes, G3 vidéos) : QC automatique —
`take_qc(grid="identity" ou "motion")` sur CHAQUE take (première frame pour les vidéos),
rapport condensé à l'utilisateur, verdicts consignés dans `film-memory.yaml`, et
`ledger_record(pattern, model, outcome)` pour chaque pattern mobilisé. Un FAIL = delta-edit
du node fautif seul.

## Ledger (A8)

Chaque run significatif alimente l'EVIDENCE-LEDGER via `ledger_record` — la base apprend de
nos pipelines (corroboration interne), pas seulement des cases externes.
