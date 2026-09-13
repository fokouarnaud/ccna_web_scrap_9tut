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
- **Chemin de la base toujours absolu** (`server/db.py`) : `DB_PATH` est calculé via `Path(__file__).resolve()`, donc absolu quel que soit le répertoire de travail (`cwd`) au démarrage du processus — jamais un chemin relatif du style `sqlite:///ma_base.db`. Nécessaire sur un hébergeur comme **PythonAnywhere**, où le process WSGI ne démarre pas forcément avec le dossier du projet comme `cwd`. Pour forcer un chemin précis (ex. sur PythonAnywhere), définis `CCNA_DB_PATH` dans `.env` :
  ```
  CCNA_DB_PATH=/home/ton_utilisateur_pythonanywhere/ccna_web_scrap_9tut/data/app.db
  ```
  (toute valeur fournie est elle-même normalisée en chemin absolu par sécurité).

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

## Déploiement sur PythonAnywhere

Le scraping (Phase 1, Playwright/Chromium) se fait **en local** — PythonAnywhere ne sert qu'à héberger l'app Flask + la base SQLite déjà remplie. Procédure complète, dans l'ordre :

### A. En local, avant de déployer

1. Termine les Phases 1 et 2 en local (`python -m scraper.run`, puis `python -m server.import_data`) pour avoir `data/ccna_questions.json`, `data/lab_sims.json` et `data/app.db` à jour.
2. Pousse le code sur un dépôt Git accessible depuis PythonAnywhere (GitHub, GitLab…), **ou** prévois d'uploader une archive zip via l'onglet **Files**. `data/app.db` étant listé dans `.gitignore`, transfère-le séparément (voir étape B.3) si tu veux partir avec les données déjà importées plutôt que ré-importer sur PythonAnywhere.

### B. Sur PythonAnywhere

1. **Récupérer le code** — ouvre une console **Bash** (onglet **Consoles**) :
   ```bash
   git clone <url-de-ton-repo> ccna_web_scrap_9tut
   ```
   (sans dépôt Git : upload un zip via l'onglet **Files**, puis `unzip mon_projet.zip` en console Bash).

2. **Uploader les données** si elles ne sont pas dans Git : onglet **Files** → navigue jusqu'à `ccna_web_scrap_9tut/data/` → upload `ccna_questions.json`, `lab_sims.json` (et `app.db` si tu veux éviter l'étape B.5).

3. **Créer un virtualenv dédié** (toujours en console Bash) :
   ```bash
   mkvirtualenv --python=python3.10 ccna-venv
   ```
   (`mkvirtualenv` place l'environnement dans `~/.virtualenvs/ccna-venv` ; adapte la version Python à ce que propose ton compte). S'il est déjà créé une prochaine fois : `workon ccna-venv` pour l'activer.

4. **Installer les dépendances côté serveur** (pas besoin de Playwright/BeautifulSoup ici, seulement Flask) :
   ```bash
   cd ccna_web_scrap_9tut
   pip install -r requirements-server.txt
   ```

5. **Importer les données en base** (si `data/app.db` n'a pas été uploadé directement à l'étape B.2) :
   ```bash
   python -m server.import_data
   ```

6. **Créer l'app web** : onglet **Web** → **Add a new web app** → choisis **Manual configuration** (pas le template "Flask" automatique — l'app de ce projet vit dans `server/app.py`, pas dans un `app.py` à la racine) → même version Python que le virtualenv.

7. **Configurer le virtualenv** : toujours onglet **Web**, section **Virtualenv**, indique :
   ```
   /home/<ton_utilisateur>/.virtualenvs/ccna-venv
   ```

8. **Configurer le fichier WSGI** : section **Code** → clique le lien bleu se terminant par `_wsgi.py` → efface tout le contenu existant → colle (en adaptant `<ton_utilisateur>` et le nom du dossier si différent) :

   ```python
   import sys

   # Dossier racine du projet (celui qui contient le package "server")
   path = '/home/<ton_utilisateur>/ccna_web_scrap_9tut'
   if path not in sys.path:
       sys.path.insert(0, path)

   # server/app.py définit "app = Flask(__name__)" — importé sous le nom
   # attendu par PythonAnywhere : "application"
   from server.app import app as application
   ```

   Sauvegarde (Ctrl+S ou le bouton Save de l'éditeur).

9. **Reload** : retourne sur l'onglet **Web**, clique le gros bouton vert **Reload**.

10. **Vérifier** : ouvre l'URL indiquée en haut de l'onglet Web (`https://<ton_utilisateur>.pythonanywhere.com`) — l'écran de connexion/inscription doit apparaître. Crée un compte de test, vérifie que les questions s'affichent. En cas d'erreur, l'onglet Web affiche un lien **Error log** avec la trace complète.

### C. Notes

- **Chemin de la base toujours absolu** (`server/db.py`) : `DB_PATH` est calculé via `Path(__file__).resolve()`, donc absolu quel que soit le `cwd` au démarrage du process — jamais un chemin relatif du style `sqlite:///ma_base.db`. Pour forcer un chemin précis, définis `CCNA_DB_PATH` dans un `.env` à la racine du projet :
  ```
  CCNA_DB_PATH=/home/<ton_utilisateur>/ccna_web_scrap_9tut/data/app.db
  ```
- `server/app.py` appelle `db.init_db()` dès son import (pas seulement au lancement local via `python -m server.app`) : la première requête sur l'app WSGI crée le schéma s'il n'existe pas déjà — pas de migration manuelle nécessaire après l'étape B.5.
- **Mettre à jour le contenu plus tard** (nouveau scraping) : en local, `python -m scraper.run` puis `python -m server.import_data` ; ré-upload `data/ccna_questions.json` et `data/lab_sims.json` (onglet Files) ; sur PythonAnywhere, `python -m server.import_data` dans une console Bash (dans le venv `ccna-venv`) ; puis **Reload** sur l'onglet Web.
- **Compte gratuit** : quota de CPU-secondes et l'app se met en pause après 3 mois d'inactivité (bouton "Run until 3 months from today" sur l'onglet Web pour la relancer) — sans impact sur le fonctionnement de l'app elle-même.

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
requirements.txt          dépendances complètes (scraping + serveur) — usage local
requirements-server.txt   dépendances minimales (Flask + python-dotenv) — usage hébergement (PythonAnywhere)
```
