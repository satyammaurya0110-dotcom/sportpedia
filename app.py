import asyncio
import json
import os
import platform
import random
import sqlite3
import subprocess
import time
from io import BytesIO

from flask import Flask, jsonify, render_template, request, send_file, session
from werkzeug.security import check_password_hash, generate_password_hash

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    psycopg2 = None

try:
    import edge_tts
except ImportError:
    edge_tts = None

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "sportpedia-v2-dev-secret-change-me")

DATABASE_URL = os.environ.get("DATABASE_URL")
SQLITE_PATH = os.environ.get("SQLITE_PATH", "sportpedia.db")
TTS_CACHE = {}


def is_postgres():
    return bool(DATABASE_URL and psycopg2 is not None)


def get_db():
    if is_postgres():
        return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def placeholder():
    return "%s" if is_postgres() else "?"


def init_db():
    conn = get_db()
    cur = conn.cursor()
    id_col = "SERIAL PRIMARY KEY" if is_postgres() else "INTEGER PRIMARY KEY AUTOINCREMENT"
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS users (
            id {id_col},
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        )
    """)
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS search_history (
            id {id_col},
            user_id INTEGER NOT NULL,
            query TEXT NOT NULL,
            searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute(f"""
        CREATE TABLE IF NOT EXISTS bookmarks (
            id {id_col},
            user_id INTEGER NOT NULL,
            sport_id INTEGER NOT NULL,
            sport_title TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, sport_id)
        )
    """)
    conn.commit()
    conn.close()


def run_c_engine(query="", category=""):
    binary = "./search_engine.exe" if platform.system() == "Windows" else "./search_engine"
    cmd = [binary, query]
    if category and category.lower() != "all":
        cmd.extend(["--category", category])
    t0 = time.perf_counter()
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 2)
    try:
        data = json.loads(res.stdout or "[]")
    except json.JSONDecodeError:
        data = []
    return data, elapsed_ms


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/search")
def search():
    q = request.args.get("q", "").strip()
    category = request.args.get("category", "").strip()
    if q and session.get("user_id"):
        conn = get_db()
        cur = conn.cursor()
        p = placeholder()
        cur.execute(f"INSERT INTO search_history (user_id, query) VALUES ({p}, {p})", (session["user_id"], q))
        conn.commit()
        conn.close()

    results, latency_ms = run_c_engine(q, category)
    return jsonify({"results": results, "count": len(results), "latency_ms": latency_ms})


@app.route("/api/categories")
def api_categories():
    results, _ = run_c_engine("", "")
    counts = {}
    for r in results:
        cat = r.get("category", "General")
        counts[cat] = counts.get(cat, 0) + 1
    return jsonify({"total": len(results), "categories": counts})


@app.route("/api/random")
def api_random():
    results, _ = run_c_engine("", "")
    if not results:
        return jsonify({"error": "Corpus empty"}), 404
    return jsonify(random.choice(results))


@app.route("/api/register", methods=["POST"])
def api_register():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    if len(username) < 3 or len(password) < 4:
        return jsonify({"error": "Username must be 3+ chars and password 4+ chars."}), 400

    conn = get_db()
    cur = conn.cursor()
    p = placeholder()
    try:
        cur.execute(
            f"INSERT INTO users (username, password_hash) VALUES ({p}, {p})",
            (username, generate_password_hash(password)),
        )
        conn.commit()
        cur.execute(f"SELECT id, username FROM users WHERE username = {p}", (username,))
        user = cur.fetchone()
        session["user_id"] = user["id"]
        session["username"] = user["username"]
        return jsonify({"ok": True, "username": user["username"]})
    except Exception:
        return jsonify({"error": "Username already exists."}), 409
    finally:
        conn.close()


@app.route("/api/login", methods=["POST"])
def api_login():
    payload = request.get_json(silent=True) or {}
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    conn = get_db()
    cur = conn.cursor()
    p = placeholder()
    cur.execute(f"SELECT id, username, password_hash FROM users WHERE username = {p}", (username,))
    user = cur.fetchone()
    conn.close()
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid username or password."}), 401
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    return jsonify({"ok": True, "username": user["username"]})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/me")
def api_me():
    if not session.get("user_id"):
        return jsonify({"authenticated": False})
    return jsonify({"authenticated": True, "username": session.get("username")})


@app.route("/api/history", methods=["GET", "DELETE"])
def api_history():
    if not session.get("user_id"):
        return jsonify({"history": []})
    conn = get_db()
    cur = conn.cursor()
    p = placeholder()
    if request.method == "DELETE":
        cur.execute(f"DELETE FROM search_history WHERE user_id = {p}", (session["user_id"],))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
    cur.execute(
        f"SELECT query FROM search_history WHERE user_id = {p} ORDER BY id DESC LIMIT 8",
        (session["user_id"],),
    )
    rows = [r["query"] for r in cur.fetchall()]
    conn.close()
    return jsonify({"history": rows})


@app.route("/api/bookmarks", methods=["GET", "POST"])
def api_bookmarks():
    if not session.get("user_id"):
        return jsonify({"bookmarks": []})
    conn = get_db()
    cur = conn.cursor()
    p = placeholder()
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        sport_id = int(payload.get("sport_id", 0))
        sport_title = (payload.get("sport_title") or "").strip()
        try:
            cur.execute(
                f"INSERT INTO bookmarks (user_id, sport_id, sport_title) VALUES ({p}, {p}, {p})",
                (session["user_id"], sport_id, sport_title),
            )
            conn.commit()
        except Exception:
            pass
        conn.close()
        return jsonify({"ok": True})
    cur.execute(f"SELECT sport_id, sport_title FROM bookmarks WHERE user_id = {p} ORDER BY id DESC", (session["user_id"],))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify({"bookmarks": rows})


@app.route("/api/bookmarks/<int:sport_id>", methods=["DELETE"])
def api_delete_bookmark(sport_id):
    if not session.get("user_id"):
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    cur = conn.cursor()
    p = placeholder()
    cur.execute(f"DELETE FROM bookmarks WHERE user_id = {p} AND sport_id = {p}", (session["user_id"], sport_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


async def _synthesize_edge_tts(text, rate="-6%"):
    communicate = edge_tts.Communicate(text, voice="en-IN-PrabhatNeural", pitch="-16Hz", rate=rate)
    audio = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
    return bytes(audio)


@app.route("/api/tts", methods=["GET", "POST"])
def api_tts():
    if edge_tts is None:
        return jsonify({"error": "edge_tts not installed"}), 503
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        text = (payload.get("text") or "").strip()
        rate = payload.get("rate", "-6%")
    else:
        text = (request.args.get("text") or "").strip()
        rate = request.args.get("rate", "-6%")
    if not text:
        return jsonify({"error": "Empty text"}), 400
    cache_key = f"{rate}::{text}"
    if cache_key not in TTS_CACHE:
        TTS_CACHE[cache_key] = asyncio.run(_synthesize_edge_tts(text, rate=rate))
    return send_file(BytesIO(TTS_CACHE[cache_key]), mimetype="audio/mpeg")


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
