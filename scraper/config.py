import os
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

BASE_URL = "https://www.9tut.com"
LOGIN_URL = f"{BASE_URL}/member/login"

USERNAME = os.environ.get("CCNA_USERNAME")
PASSWORD = os.environ.get("CCNA_PASSWORD")

AUTH_STATE_PATH = Path(__file__).resolve().parent / ".auth_state.json"

DATA_DIR = ROOT_DIR / "data"
QUESTIONS_FILE = DATA_DIR / "ccna_questions.json"
LAB_SIMS_FILE = DATA_DIR / "lab_sims.json"

REQUEST_DELAY_SECONDS = 1.5

# Images referenced by scraped pages/questions are downloaded here so the app
# never depends on 9tut.com staying up or hotlink-friendly. Served by Flask's
# existing catch-all static route (server/app.py), so the URL prefix below
# must match this directory's location under review_app/.
IMAGES_DIR = ROOT_DIR / "review_app" / "images"
IMAGES_URL_PREFIX = "/images"
