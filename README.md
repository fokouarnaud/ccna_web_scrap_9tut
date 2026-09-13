# CCNA 200-301 — Scraper 9tut.com + App de révision

Le projet a trois phases indépendantes :

1. **Scraping** — se connecte à 9tut.com et génère les fichiers `data/*.json`. Nécessite Python, Playwright et un compte 9tut.com. À faire une fois, puis à refaire seulement quand tu veux rafraîchir les données.
2. **Import en base** — charge ces fichiers JSON dans une base SQLite (`data/app.db`), qui devient la source de vérité permanente (contenu **et** progression utilisateur). À refaire après chaque nouveau scraping.
3. **Utilisation** — un serveur Flask (`server/app.py`) sert l'app de révision et une API : comptes utilisateurs (inscription, connexion, infos, suppression) et progression (questions vues, difficiles, quiz, examens) stockés en base, donc **jamais perdus en vidant le cache du navigateur**.

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

---

## Phase 2 — Import en base de données

```
python -m server.import_data
```

Charge `data/ccna_questions.json` et `data/lab_sims.json` dans `data/app.db` (SQLite). **Relance cette commande après chaque nouveau scraping** pour que l'app serve le contenu à jour.

**Politique anti-corruption de la base :**
- `PRAGMA journal_mode = WAL` + `PRAGMA foreign_keys = ON` à chaque connexion (voir `server/db.py`).
- Chaque import s'exécute dans **une seule transaction** (`server/db.py::transaction()`) : si le script est interrompu (Ctrl-C, crash) en plein import, tout est annulé (`ROLLBACK`) et la base reste dans son dernier état cohérent — jamais de pages ou questions à moitié écrites.
- Les écritures sont des **upserts** (`INSERT ... ON CONFLICT DO UPDATE`) sur la clé naturelle (URL de la page, ou `page_url + numéro` pour une question) : relancer l'import plusieurs fois ne duplique jamais rien.
- Même politique pour l'API (chaque requête qui écrit plusieurs lignes — ex. enregistrer un examen complet avec le détail par question — le fait dans une transaction unique).
- Sauvegarde manuelle recommandée avant une session d'examen importante : `sqlite3 data/app.db ".backup data/app.db.bak"` (copie cohérente même si l'app tourne).

## Phase 3 — Utilisation (App de révision + comptes)

```
python -m server.app
```

Lance le serveur sur `http://127.0.0.1:8090/` (le serveur Flask sert à la fois l'app statique et l'API — pas besoin de `http.server` séparé). Si le port 8090 est occupé ou réservé sur ta machine (Windows réserve parfois des plages de ports, ex. 4901-5000 côté Hyper-V — vérifiable avec `netsh interface ipv4 show excludedportrange protocol=tcp`), change le port dans `server/app.py` (`app.run(..., port=...)`).

À la première ouverture : crée un compte (nom d'utilisateur + mot de passe, email optionnel). Toute la progression est ensuite liée à ce compte et stockée dans `data/app.db` :
- questions vues, questions marquées "difficiles",
- statistiques de quiz par catégorie,
- historique complet des examens (score, temps, détail par question).

Le navigateur ne garde qu'un jeton de session (dans `localStorage`) — le perdre (cache vidé, autre navigateur, autre machine) ne fait que déconnecter : se reconnecter avec le même compte restaure exactement la même progression.

Mot de passe stocké en PBKDF2-HMAC-SHA256 (200 000 itérations, sel aléatoire par compte) — jamais en clair.

### Gestion du compte (⚙️ dans la barre latérale)
- Modifier le nom affiché / l'email.
- Changer le mot de passe.
- **Supprimer le compte** : double confirmation, puis suppression en cascade (transaction unique) de l'utilisateur et de toute sa progression — sessions, questions vues/difficiles, stats de quiz, historique d'examens.

### Fonctionnalités de l'app
- Navigation par catégorie / page, comme le menu du site.
- Réponses cachées par défaut, révélées question par question ou toutes en même temps.
- Marquage "question difficile" (⭐) persistant, avec vue "Révision" dédiée.
- Mode Quiz (choix aléatoire, portée par catégorie/page/questions difficiles, score final).
- **Mode Examen** : simulation en conditions réelles — N questions (60 par défaut) chronométrées (120 min par défaut). Les pages/catégories sources sont à cocher librement (case à cocher par page, dans CCNA 200-301 **et** Premium Member Zone, avec boutons "Tout cocher/décocher" par catégorie), dans l'ordre des pages cochées ou aléatoirement ; une présélection par défaut couvre les 60 premières questions de CCNA 200-301 (Basic Questions → STP & VTP Questions). Réponses et explications restent masquées pendant l'examen ; navigation libre via une palette de numéros. Le temps passé sur chaque question est chronométré individuellement (affiché en direct).
  À la fin (ou au temps écoulé) : score, temps utilisé, **analyse du temps** (questions les plus lentes à répondre, avec bouton pour les marquer "difficiles" afin de les retravailler), liste des questions ratées avec la page source (lien interne + référence externe si disponible) et l'explication, bouton pour marquer en masse les questions ratées comme "difficiles", et historique des tentatives pour suivre la progression (score et temps) dans le temps.
- **🩹 Examen spécial "questions difficiles"** : reprend uniquement les questions marquées ⭐, avec une durée calculée automatiquement selon leur nombre (≈2 min/question) et plafonnée à 2h. Toute question répondue correctement y est automatiquement retirée de la liste "difficiles" (maîtrisée) ; les questions encore ratées ou lentes y restent/y sont ajoutées — un cycle de révision qui se réduit au fil des tentatives.
- Suivi de progression (questions vues) et statistiques de quiz — tout est désormais stocké côté serveur (base SQLite), par compte.

## Structure du projet

```
scraper/        scraping Playwright -> data/*.json
server/
  schema.sql    DDL SQLite (pages, questions, users, sessions, progress_*, exam_*)
  db.py         connexion + transactions
  auth.py       hachage de mot de passe (PBKDF2)
  import_data.py  data/*.json -> data/app.db
  app.py        API Flask + service des fichiers statiques de review_app/
review_app/     frontend (HTML/CSS/JS), consomme l'API via api.js
data/
  ccna_questions.json, lab_sims.json   sortie brute du scraper
  app.db        base SQLite (contenu + comptes + progression) — source de vérité à l'exécution
```
