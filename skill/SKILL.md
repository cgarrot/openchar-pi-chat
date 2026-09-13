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
