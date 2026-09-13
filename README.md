# CCNA 200-301 — Scraper 9tut.com + App de révision

Le projet a deux phases indépendantes :

1. **Scraping** — se connecte à 9tut.com et génère les fichiers `data/*.json`. Nécessite Python, Playwright et un compte 9tut.com. À faire une fois, puis à refaire seulement quand tu veux rafraîchir les données.
2. **Utilisation** — parcourt et révise les questions déjà extraites via `review_app/`. Ne nécessite qu'un navigateur + un petit serveur statique (aucun compte, aucune dépendance Python). Une fois `data/` généré, tu peux même copier `data/` + `review_app/` sur une autre machine et sauter la phase 1.

---

## Phase 1 — Scraping

### 1.1 Créer et activer un environnement virtuel (.venv)

**Windows (PowerShell) :**
```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
```

**Windows (cmd.exe) :**
```cmd
py -m venv .venv
.venv\Scripts\activate.bat
```

**macOS / Linux (bash/zsh) :**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

Une fois activé, le prompt affiche `(.venv)` devant la ligne de commande. Pour en sortir plus tard : `deactivate` (identique sur les trois OS).

> Si PowerShell refuse d'exécuter le script d'activation (`... is not digitally signed` ou erreur de policy), lance une fois : `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, puis réessaie.

### 1.2 Installer les dépendances (dans le .venv activé)

```
pip install -r requirements.txt
python -m playwright install chromium
```

### 1.3 Configurer les identifiants

Crée un fichier `.env` (déjà présent, basé sur `.env.example`) avec ton compte 9tut.com :

```
CCNA_USERNAME=...
CCNA_PASSWORD=...
```

### 1.4 Lancer le scraper

```
python -m scraper.run --limit 2      # test rapide sur 2 pages
python -m scraper.run                # scrape tout (catégorie CCNA 200-301 + Premium Member Zone)
python -m scraper.run --force        # force le re-scraping de tout (ignore le cache local)
```

Résultats écrits dans :
- `data/ccna_questions.json` — pages avec questions/choix/réponse/explication.
- `data/lab_sims.json` — pages "Lab Sims" et autres pages sans format QCM (titre + texte + images).

Le script est idempotent : relancer sans `--force` ne re-scrape que les pages absentes des fichiers JSON existants. La session de connexion est mise en cache dans `scraper/.auth_state.json`.

Une fois `data/ccna_questions.json` et `data/lab_sims.json` générés, tu peux désactiver le venv (`deactivate`) — la phase 2 n'en a plus besoin.

---

## Phase 2 — Utilisation (App de révision)

L'app charge les fichiers JSON via `fetch()`, ce que les navigateurs bloquent en `file://`. Il faut donc un petit serveur statique — pas de venv ni de dépendance Python requise, seul le module standard `http.server` suffit.

**Windows / macOS / Linux (même commande) :**
```
python -m http.server 8000
```
(ou `py -m http.server 8000` sur Windows si `python` n'est pas sur le PATH)

Lance-la depuis la racine du projet, puis ouvre `http://localhost:8000/review_app/`.

Fonctionnalités :
- Navigation par catégorie / page, comme le menu du site.
- Réponses cachées par défaut, révélées question par question ou toutes en même temps.
- Marquage "question difficile" (⭐) persistant, avec vue "Révision" dédiée.
- Mode Quiz (choix aléatoire, portée par catégorie/page/questions difficiles, score final).
- **Mode Examen** : simulation en conditions réelles — N questions (60 par défaut) chronométrées (120 min par défaut). Les pages/catégories sources sont à cocher librement (case à cocher par page, dans CCNA 200-301 **et** Premium Member Zone, avec boutons "Tout cocher/décocher" par catégorie), dans l'ordre des pages cochées ou aléatoirement ; une présélection par défaut couvre les 60 premières questions de CCNA 200-301 (Basic Questions → STP & VTP Questions). Réponses et explications restent masquées pendant l'examen ; navigation libre via une palette de numéros. Le temps passé sur chaque question est chronométré individuellement (affiché en direct).
  À la fin (ou au temps écoulé) : score, temps utilisé, **analyse du temps** (questions les plus lentes à répondre, avec bouton pour les marquer "difficiles" afin de les retravailler), liste des questions ratées avec la page source (lien interne + référence externe si disponible) et l'explication, bouton pour marquer en masse les questions ratées comme "difficiles", et historique des tentatives pour suivre la progression (score et temps) dans le temps.
- **🩹 Examen spécial "questions difficiles"** : reprend uniquement les questions marquées ⭐, avec une durée calculée automatiquement selon leur nombre (≈2 min/question) et plafonnée à 2h. Toute question répondue correctement y est automatiquement retirée de la liste "difficiles" (maîtrisée) ; les questions encore ratées ou lentes y restent/y sont ajoutées — un cycle de révision qui se réduit au fil des tentatives.
- Suivi de progression (questions vues) et statistiques de quiz, stockés en local (`localStorage`).
