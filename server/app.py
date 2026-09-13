import functools
import json
import secrets
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory

from . import db
from .auth import hash_password, verify_password

ROOT = Path(__file__).resolve().parent.parent
REVIEW_APP_DIR = ROOT / "review_app"
SESSION_LIFETIME_DAYS = 30

app = Flask(__name__)


def utcnow_iso() -> str:
    return datetime.utcnow().isoformat()


def new_session(conn, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(days=SESSION_LIFETIME_DAYS)).isoformat()
    conn.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", (token, user_id, expires_at))
    return token


def user_public(row) -> dict:
    return {"username": row["username"], "email": row["email"], "display_name": row["display_name"]}


def require_auth(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else None
        if not token:
            return jsonify({"error": "missing token"}), 401
        conn = db.get_connection()
        try:
            row = conn.execute(
                """
                SELECT s.user_id, s.expires_at, u.username, u.email, u.display_name
                FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token = ?
                """,
                (token,),
            ).fetchone()
        finally:
            conn.close()
        if not row or row["expires_at"] < utcnow_iso():
            return jsonify({"error": "invalid or expired session"}), 401
        g.user_id = row["user_id"]
        g.user = user_public(row)
        g.token = token
        return fn(*args, **kwargs)

    return wrapper


# ---------------------------------------------------------------- static app

@app.route("/")
def index():
    return send_from_directory(REVIEW_APP_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(REVIEW_APP_DIR, path)


# ---------------------------------------------------------------------- auth

@app.post("/api/register")
def register():
    data = request.get_json(force=True) or {}
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip() or None
    password = data.get("password") or ""
    display_name = (data.get("display_name") or username).strip()

    if len(username) < 3 or len(password) < 6:
        return jsonify({"error": "Le nom d'utilisateur (>=3 caractères) et le mot de passe (>=6 caractères) sont requis."}), 400

    password_hash, password_salt = hash_password(password)

    try:
        with db.transaction() as conn:
            cur = conn.execute(
                "INSERT INTO users (username, email, display_name, password_hash, password_salt) VALUES (?, ?, ?, ?, ?)",
                (username, email, display_name, password_hash, password_salt),
            )
            user_id = cur.lastrowid
            token = new_session(conn, user_id)
    except sqlite3.IntegrityError:
        return jsonify({"error": "Ce nom d'utilisateur ou cet email est déjà utilisé."}), 409

    return jsonify({"token": token, "user": {"username": username, "email": email, "display_name": display_name}})


@app.post("/api/login")
def login():
    data = request.get_json(force=True) or {}
    identifier = (data.get("username") or "").strip()
    password = data.get("password") or ""

    conn = db.get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ? OR email = ?", (identifier, identifier)).fetchone()
    finally:
        conn.close()

    if not row or not verify_password(password, row["password_salt"], row["password_hash"]):
        return jsonify({"error": "Identifiants invalides."}), 401

    with db.transaction() as conn2:
        token = new_session(conn2, row["id"])

    return jsonify({"token": token, "user": user_public(row)})


@app.post("/api/logout")
@require_auth
def logout():
    with db.transaction() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (g.token,))
    return jsonify({"ok": True})


@app.get("/api/me")
@require_auth
def me():
    return jsonify({"user": g.user})


@app.put("/api/me")
@require_auth
def update_me():
    data = request.get_json(force=True) or {}
    display_name = data.get("display_name")
    email = data.get("email")
    try:
        with db.transaction() as conn:
            conn.execute(
                "UPDATE users SET display_name = COALESCE(?, display_name), email = COALESCE(?, email) WHERE id = ?",
                (display_name, email, g.user_id),
            )
    except sqlite3.IntegrityError:
        return jsonify({"error": "Cet email est déjà utilisé."}), 409
    return jsonify({"ok": True})


@app.put("/api/me/password")
@require_auth
def change_password():
    data = request.get_json(force=True) or {}
    new_password = data.get("password") or ""
    if len(new_password) < 6:
        return jsonify({"error": "Le mot de passe doit contenir au moins 6 caractères."}), 400
    password_hash, password_salt = hash_password(new_password)
    with db.transaction() as conn:
        conn.execute("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", (password_hash, password_salt, g.user_id))
    return jsonify({"ok": True})


@app.delete("/api/me")
@require_auth
def delete_me():
    # ON DELETE CASCADE (sessions, progress_seen, progress_flagged, quiz_stats,
    # exam_history -> exam_question_results) wipes every trace of the account
    # in the same transaction.
    with db.transaction() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (g.user_id,))
    return jsonify({"ok": True})


# ----------------------------------------------------------- scraped content

@app.get("/api/questions")
def get_questions():
    conn = db.get_connection()
    try:
        pages = conn.execute("SELECT * FROM pages WHERE kind = 'qa' ORDER BY rowid").fetchall()
        result = []
        for page in pages:
            questions = conn.execute(
                "SELECT * FROM questions WHERE page_url = ? ORDER BY number", (page["url"],)
            ).fetchall()
            result.append(
                {
                    "url": page["url"],
                    "title": page["title"],
                    "category": page["category"],
                    "section": page["section"],
                    "intro": page["intro"] or "",
                    "questions": [
                        {
                            "number": q["number"],
                            "text": q["text"],
                            "choices": json.loads(q["choices"]),
                            "answer": json.loads(q["answer"]),
                            "multi_answer": bool(q["multi_answer"]),
                            "explanation": q["explanation"] or "",
                            "reference": q["reference"],
                            "images": json.loads(q["images"]),
                        }
                        for q in questions
                    ],
                }
            )
        return jsonify(result)
    finally:
        conn.close()


@app.get("/api/lab-sims")
def get_lab_sims():
    conn = db.get_connection()
    try:
        pages = conn.execute("SELECT * FROM pages WHERE kind = 'generic' ORDER BY rowid").fetchall()
        return jsonify(
            [
                {
                    "url": p["url"],
                    "title": p["title"],
                    "category": p["category"],
                    "section": p["section"],
                    "text": p["text"] or "",
                    "images": json.loads(p["images"] or "[]"),
                }
                for p in pages
            ]
        )
    finally:
        conn.close()


# -------------------------------------------------------------- user progress

@app.get("/api/progress")
@require_auth
def get_progress():
    conn = db.get_connection()
    try:
        seen = [r["question_key"] for r in conn.execute("SELECT question_key FROM progress_seen WHERE user_id = ?", (g.user_id,))]
        flagged = [r["question_key"] for r in conn.execute("SELECT question_key FROM progress_flagged WHERE user_id = ?", (g.user_id,))]
        quiz_stats = {
            r["category"]: {"correct": r["correct"], "total": r["total"]}
            for r in conn.execute("SELECT category, correct, total FROM quiz_stats WHERE user_id = ?", (g.user_id,))
        }
        exam_rows = conn.execute("SELECT * FROM exam_history WHERE user_id = ? ORDER BY id", (g.user_id,)).fetchall()
        exam_history = [
            {
                "id": r["id"],
                "date": r["date"],
                "label": r["label"],
                "mode": r["mode"],
                "score": r["score"],
                "total": r["total"],
                "durationSeconds": r["duration_seconds"],
                "timeLimitSeconds": r["time_limit_seconds"],
                "timedOut": bool(r["timed_out"]),
            }
            for r in exam_rows
        ]
        return jsonify({"seen": seen, "flagged": flagged, "quizStats": quiz_stats, "examHistory": exam_history})
    finally:
        conn.close()


@app.post("/api/progress/seen")
@require_auth
def mark_seen():
    qkey = (request.get_json(force=True) or {}).get("questionId")
    if not qkey:
        return jsonify({"error": "questionId required"}), 400
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO progress_seen (user_id, question_key) VALUES (?, ?) ON CONFLICT(user_id, question_key) DO NOTHING",
            (g.user_id, qkey),
        )
    return jsonify({"ok": True})


@app.post("/api/progress/flag")
@require_auth
def set_flag():
    data = request.get_json(force=True) or {}
    qkey = data.get("questionId")
    flagged = bool(data.get("flagged"))
    if not qkey:
        return jsonify({"error": "questionId required"}), 400
    with db.transaction() as conn:
        if flagged:
            conn.execute(
                "INSERT INTO progress_flagged (user_id, question_key) VALUES (?, ?) ON CONFLICT(user_id, question_key) DO NOTHING",
                (g.user_id, qkey),
            )
        else:
            conn.execute("DELETE FROM progress_flagged WHERE user_id = ? AND question_key = ?", (g.user_id, qkey))
    return jsonify({"ok": True})


@app.post("/api/progress/flags-bulk")
@require_auth
def set_flags_bulk():
    data = request.get_json(force=True) or {}
    add = data.get("add") or []
    remove = data.get("remove") or []
    with db.transaction() as conn:
        for qkey in add:
            conn.execute(
                "INSERT INTO progress_flagged (user_id, question_key) VALUES (?, ?) ON CONFLICT(user_id, question_key) DO NOTHING",
                (g.user_id, qkey),
            )
        for qkey in remove:
            conn.execute("DELETE FROM progress_flagged WHERE user_id = ? AND question_key = ?", (g.user_id, qkey))
    return jsonify({"ok": True})


@app.post("/api/progress/quiz-stat")
@require_auth
def record_quiz_stat():
    data = request.get_json(force=True) or {}
    category = data.get("category")
    is_correct = bool(data.get("isCorrect"))
    if not category:
        return jsonify({"error": "category required"}), 400
    with db.transaction() as conn:
        conn.execute(
            """
            INSERT INTO quiz_stats (user_id, category, correct, total) VALUES (?, ?, ?, 1)
            ON CONFLICT(user_id, category) DO UPDATE SET
              correct = correct + excluded.correct,
              total = total + 1
            """,
            (g.user_id, category, 1 if is_correct else 0),
        )
    return jsonify({"ok": True})


@app.post("/api/progress/exam")
@require_auth
def record_exam():
    data = request.get_json(force=True) or {}
    required = ["date", "score", "total", "durationSeconds", "timeLimitSeconds"]
    if any(k not in data for k in required):
        return jsonify({"error": "missing fields"}), 400

    with db.transaction() as conn:
        cur = conn.execute(
            """
            INSERT INTO exam_history
              (user_id, date, label, mode, score, total, duration_seconds, time_limit_seconds, timed_out, is_difficult_review)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                g.user_id,
                data["date"],
                data.get("label"),
                data.get("mode"),
                data["score"],
                data["total"],
                data["durationSeconds"],
                data["timeLimitSeconds"],
                1 if data.get("timedOut") else 0,
                1 if data.get("isDifficultReview") else 0,
            ),
        )
        exam_id = cur.lastrowid
        for detail in data.get("questionResults", []):
            conn.execute(
                """
                INSERT INTO exam_question_results (exam_id, question_key, given_letters, time_seconds, is_correct)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    exam_id,
                    detail["questionKey"],
                    json.dumps(detail.get("given", []), ensure_ascii=False),
                    detail.get("timeSeconds", 0),
                    1 if detail.get("isCorrect") else 0,
                ),
            )

    return jsonify({"ok": True, "examId": exam_id})


def main():
    db.init_db()
    app.run(host="127.0.0.1", port=8090, debug=False)


if __name__ == "__main__":
    main()
