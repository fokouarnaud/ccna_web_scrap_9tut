"""Load the scraper's JSON output into the SQLite database.

Run this once after every `python -m scraper.run`. It is safe to run
repeatedly: every write is an upsert (INSERT ... ON CONFLICT DO UPDATE) keyed
on the page URL / question number, and the whole import runs inside a single
transaction, so a crash or Ctrl-C mid-import leaves the database at its last
good state instead of half-written.

Also prunes rows that disappeared from the source between two scrapes (a
question renumbered or removed on 9tut.com) so the database never keeps
serving stale content the JSON no longer has — guarded so an empty/missing
JSON file (a bug, not a real "everything was deleted" scrape) can never wipe
the whole table.
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
                INSERT INTO pages (url, title, category, section, kind, intro, images, links)
                VALUES (?, ?, ?, ?, 'qa', ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                  title = excluded.title,
                  category = excluded.category,
                  section = excluded.section,
                  intro = excluded.intro,
                  images = excluded.images,
                  links = excluded.links,
                  scraped_at = datetime('now')
                """,
                (
                    page["url"],
                    page["title"],
                    page["category"],
                    page.get("section"),
                    page.get("intro", ""),
                    json.dumps(page.get("images", []), ensure_ascii=False),
                    json.dumps(page.get("links", []), ensure_ascii=False),
                ),
            )
            for q in page["questions"]:
                question_count += 1
                conn.execute(
                    """
                    INSERT INTO questions (page_url, number, text, choices, answer, multi_answer, explanation, reference, images, links)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(page_url, number) DO UPDATE SET
                      text = excluded.text,
                      choices = excluded.choices,
                      answer = excluded.answer,
                      multi_answer = excluded.multi_answer,
                      explanation = excluded.explanation,
                      reference = excluded.reference,
                      images = excluded.images,
                      links = excluded.links
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
                        json.dumps(q.get("links", []), ensure_ascii=False),
                    ),
                )

        for page in generic_pages:
            conn.execute(
                """
                INSERT INTO pages (url, title, category, section, kind, text, images, links)
                VALUES (?, ?, ?, ?, 'generic', ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                  title = excluded.title,
                  category = excluded.category,
                  section = excluded.section,
                  text = excluded.text,
                  images = excluded.images,
                  links = excluded.links,
                  scraped_at = datetime('now')
                """,
                (
                    page["url"],
                    page["title"],
                    page["category"],
                    page.get("section"),
                    page.get("text", ""),
                    json.dumps(page.get("images", []), ensure_ascii=False),
                    json.dumps(page.get("links", []), ensure_ascii=False),
                ),
            )

        pruned_pages = 0
        pruned_questions = 0

        if qa_pages:
            current_qa_urls = {page["url"] for page in qa_pages}
            db_qa_urls = {r["url"] for r in conn.execute("SELECT url FROM pages WHERE kind = 'qa'")}
            for url in db_qa_urls - current_qa_urls:
                conn.execute("DELETE FROM pages WHERE url = ?", (url,))  # cascades to its questions
                pruned_pages += 1

            current_question_keys = {(page["url"], q["number"]) for page in qa_pages for q in page["questions"]}
            db_question_keys = {(r["page_url"], r["number"]) for r in conn.execute("SELECT page_url, number FROM questions")}
            for page_url, number in db_question_keys - current_question_keys:
                conn.execute("DELETE FROM questions WHERE page_url = ? AND number = ?", (page_url, number))
                pruned_questions += 1

        if generic_pages:
            current_generic_urls = {page["url"] for page in generic_pages}
            db_generic_urls = {r["url"] for r in conn.execute("SELECT url FROM pages WHERE kind = 'generic'")}
            for url in db_generic_urls - current_generic_urls:
                conn.execute("DELETE FROM pages WHERE url = ?", (url,))
                pruned_pages += 1

    return {
        "qa_pages": len(qa_pages),
        "questions": question_count,
        "generic_pages": len(generic_pages),
        "pruned_pages": pruned_pages,
        "pruned_questions": pruned_questions,
    }


if __name__ == "__main__":
    result = import_all()
    print(
        f"Imported {result['qa_pages']} Q&A pages ({result['questions']} questions) "
        f"and {result['generic_pages']} generic pages into {db.DB_PATH}"
    )
    if result["pruned_pages"] or result["pruned_questions"]:
        print(f"Pruned {result['pruned_pages']} stale page(s) and {result['pruned_questions']} stale question(s) no longer in the source")
