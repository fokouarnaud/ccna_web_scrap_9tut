"""Load the scraper's JSON output into the SQLite database.

Run this once after every `python -m scraper.run`. It is safe to run
repeatedly: every write is an upsert (INSERT ... ON CONFLICT DO UPDATE) keyed
on the page URL / question number, and the whole import runs inside a single
transaction, so a crash or Ctrl-C mid-import leaves the database at its last
good state instead of half-written.
"""

import json
from pathlib import Path

from . import db

ROOT = Path(__file__).resolve().parent.parent
QUESTIONS_FILE = ROOT / "data" / "ccna_questions.json"
LAB_SIMS_FILE = ROOT / "data" / "lab_sims.json"


def import_all() -> dict:
    db.init_db()

    qa_pages = json.loads(QUESTIONS_FILE.read_text(encoding="utf-8")) if QUESTIONS_FILE.exists() else []
    generic_pages = json.loads(LAB_SIMS_FILE.read_text(encoding="utf-8")) if LAB_SIMS_FILE.exists() else []

    question_count = 0
    with db.transaction() as conn:
        for page in qa_pages:
            conn.execute(
                """
                INSERT INTO pages (url, title, category, section, kind, intro)
                VALUES (?, ?, ?, ?, 'qa', ?)
                ON CONFLICT(url) DO UPDATE SET
                  title = excluded.title,
                  category = excluded.category,
                  section = excluded.section,
                  intro = excluded.intro,
                  scraped_at = datetime('now')
                """,
                (page["url"], page["title"], page["category"], page.get("section"), page.get("intro", "")),
            )
            for q in page["questions"]:
                question_count += 1
                conn.execute(
                    """
                    INSERT INTO questions (page_url, number, text, choices, answer, multi_answer, explanation, reference, images)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(page_url, number) DO UPDATE SET
                      text = excluded.text,
                      choices = excluded.choices,
                      answer = excluded.answer,
                      multi_answer = excluded.multi_answer,
                      explanation = excluded.explanation,
                      reference = excluded.reference,
                      images = excluded.images
                    """,
                    (
                        page["url"],
                        q["number"],
                        q["text"],
                        json.dumps(q["choices"], ensure_ascii=False),
                        json.dumps(q["answer"], ensure_ascii=False),
                        1 if q.get("multi_answer") else 0,
                        q.get("explanation") or "",
                        q.get("reference"),
                        json.dumps(q.get("images", []), ensure_ascii=False),
                    ),
                )

        for page in generic_pages:
            conn.execute(
                """
                INSERT INTO pages (url, title, category, section, kind, text, images)
                VALUES (?, ?, ?, ?, 'generic', ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                  title = excluded.title,
                  category = excluded.category,
                  section = excluded.section,
                  text = excluded.text,
                  images = excluded.images,
                  scraped_at = datetime('now')
                """,
                (
                    page["url"],
                    page["title"],
                    page["category"],
                    page.get("section"),
                    page.get("text", ""),
                    json.dumps(page.get("images", []), ensure_ascii=False),
                ),
            )

    return {"qa_pages": len(qa_pages), "questions": question_count, "generic_pages": len(generic_pages)}


if __name__ == "__main__":
    result = import_all()
    print(
        f"Imported {result['qa_pages']} Q&A pages ({result['questions']} questions) "
        f"and {result['generic_pages']} generic pages into {db.DB_PATH}"
    )
