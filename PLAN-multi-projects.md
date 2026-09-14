# Multi-projets par onglets — plan

## Objectif
Des onglets de projets en haut de l'app : plusieurs projets ouverts en parallèle, switch
instantané, générations qui continuent dans le bon projet pendant qu'on bosse ailleurs.

## Architecture choisie (validée contre le code)
**Onglets côté client + projet actif côté serveur.**
- Le serveur garde UN projet ouvert (comme aujourd'hui) — `project:open` est une réouverture
  SQLite rapide (<100 ms), idempotente.
- Le frontend gère N onglets (méta-données : id, nom, chemin) ; **switcher = `project:open` +
  remontée du Workspace** (`key={project.id}`) → les stores (board/frames/assets) se rechargent
  proprement (déjà câblé au montage de MoodboardPanel).
- **Les runs survivent au switch** : `CoreGeneration` épingle `project_ref()` à la soumission
  (`_drain(item_id, record, ref)`) — les takes atterrissent dans le projet d'origine, pas dans
  celui affiché. Vérifié dans generation.py.
- Les événements (génération/board) restent globaux : les ids étant des UUID, pas de collision
  entre projets ; le panneau d'activité montre donc les runs des deux projets (utile).

## Décision écartée
Refactor serveur multi-connexions (chaque canal routererait par projectId) : ~40 handlers à
toucher, risque élevé, bénéfice nul pour le besoin (un seul canvas visible à la fois).

## Implémentation

### 1. projectStore — état onglets
- `tabs: ProjectTab[]` ({id, name, path}), `activeTabId`, persistance localStorage
  (`openchar-project-tabs`).
- `adopt(project)` : ajoute/active l'onglet — appelé par TOUS les chemins d'ouverture
  (create, dialog, zip, path) pour que le launcher intègre les onglets.
- `switchTab(id)` : `project.open(path)` → `current` + `activeTabId` (le remount recharge).
- `closeTab(id)` : retire ; si actif → voisin, sinon launcher (`closeProject`).
- `restore()` complète : au boot, les onglets stockés sont restaurés (l'actif rouvre côté
  serveur via restore_last_project existant).

### 2. UI — barre d'onglets (header du Workspace)
- Puces compactes à la place du nom statique : actif surligné, ✕ au survol, badge d'erreur si
  le dossier a disparu.
- « + » : menu des récents (`project:listRecent`) + « Parcourir… » (dialog).
- Le logo (retour projets) ferme tous les onglets → launcher.

### 3. App.tsx
- `<Workspace key={current.id} project={current}/>` : remont par projet = reset local garanti.

### 4. Limites assumées (v1)
- Un canvas visible à la fois (le switch est instantané, pas de split-view).
- Le chat est global (pas par projet) — l'agent peut opérer sur le projet actif.
- Onglets en mémoire de page + localStorage : pas de synchronisation multi-fenêtres.

## Phases
- **T1** : store onglets + persistance + adopt sur toutes les ouvertures. ✅
- **T2** : barre d'onglets UI + menu +/récents. ✅
- **T3** : remount par key + restauration au boot. ✅
- **T4 (plus tard si besoin)** : split-view 2 canvas, onglets par fenêtre, badge de runs
  actifs par onglet.
