from flask import Flask, render_template, request, jsonify, session, Response
from werkzeug.security import generate_password_hash, check_password_hash
import subprocess
import sqlite3
import json
import os
import asyncio
import io
import edge_tts

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "sportpedia-super-secret-key-2026")

ENGINE_PATH = "./search_engine.exe" if os.name == "nt" else "./search_engine"
DB_PATH = "sportpedia.db"
DATABASE_URL = os.environ.get("DATABASE_URL")  # Optional cloud PostgreSQL URL

if DATABASE_URL:
    import psycopg2
    from psycopg2.extras import RealDictCursor

def get_db_connection():
    if DATABASE_URL:
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
        return conn, True
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        return conn, False

def init_db():
    conn, is_postgres = get_db_connection()
    cur = conn.cursor()
    if is_postgres:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS search_history (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                query TEXT NOT NULL,
                searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
    else:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                query TEXT NOT NULL,
                searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
        """)
    conn.commit()
    cur.close()
    conn.close()

init_db()

@app.route("/")
def index():
    return render_template("index.html")

# --- AUTHENTICATION API ---

@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if len(username) < 3 or len(password) < 4:
        return jsonify({"error": "Username (min 3 chars) and password (min 4 chars) required."}), 400

    hashed_pw = generate_password_hash(password)
    conn, is_postgres = get_db_connection()
    cur = conn.cursor()

    try:
        if is_postgres:
            cur.execute("INSERT INTO users (username, password_hash) VALUES (%s, %s) RETURNING id", (username, hashed_pw))
            user_id = cur.fetchone()["id"]
        else:
            cur.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, hashed_pw))
            user_id = cur.lastrowid
        conn.commit()
        session["user_id"] = user_id
        session["username"] = username
        return jsonify({"message": "Account created successfully", "username": username})
    except Exception:
        return jsonify({"error": "Username already exists. Please choose another."}), 409
    finally:
        cur.close()
        conn.close()

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    conn, is_postgres = get_db_connection()
    cur = conn.cursor()
    placeholder = "%s" if is_postgres else "?"
    cur.execute(f"SELECT * FROM users WHERE username = {placeholder}", (username,))
    user = cur.fetchone()
    cur.close()
    conn.close()

    if user and check_password_hash(user["password_hash"], password):
        session["user_id"] = user["id"]
        session["username"] = user["username"]
        return jsonify({"message": "Logged in", "username": user["username"]})
    return jsonify({"error": "Invalid username or password."}), 401

@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"message": "Logged out"})

@app.route("/api/me")
def current_user():
    if "user_id" in session:
        return jsonify({"logged_in": True, "username": session["username"]})
    return jsonify({"logged_in": False})

# --- SEARCH HISTORY API ---

@app.route("/api/history", methods=["GET", "DELETE"])
def handle_history():
    if "user_id" not in session:
        return jsonify([])

    user_id = session["user_id"]
    conn, is_postgres = get_db_connection()
    cur = conn.cursor()
    placeholder = "%s" if is_postgres else "?"

    if request.method == "DELETE":
        cur.execute(f"DELETE FROM search_history WHERE user_id = {placeholder}", (user_id,))
        conn.commit()
        cur.close()
        conn.close()
        return jsonify({"message": "History cleared"})

    cur.execute(f"""
        SELECT query, searched_at FROM search_history 
        WHERE user_id = {placeholder} 
        ORDER BY id DESC LIMIT 8
    """, (user_id,))
    rows = cur.fetchall()
    cur.close()
    conn.close()

    history_list = []
    seen = set()
    for r in rows:
        q = r["query"]
        if q.lower() not in seen:
            seen.add(q.lower())
            history_list.append(q)
    return jsonify(history_list)

# --- C SEARCH ENGINE ROUTE ---

@app.route("/search")
def search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])

    # Save search to user's cloud history if logged in
    if "user_id" in session:
        try:
            conn, is_postgres = get_db_connection()
            cur = conn.cursor()
            placeholder = "%s" if is_postgres else "?"
            cur.execute(f"INSERT INTO search_history (user_id, query) VALUES ({placeholder}, {placeholder})", (session["user_id"], query))
            conn.commit()
            cur.close()
            conn.close()
        except Exception as e:
            print(f"History save error: {e}")

    try:
        result = subprocess.run(
            [ENGINE_PATH, query],
            capture_output=True,
            text=True,
            check=True
        )
        data = json.loads(result.stdout)
        return jsonify(data)
    except Exception as e:
        print(f"Error running search engine: {e}")
        return jsonify([])

# --- NEURAL BARITONE VOICE ENGINE (FAST CACHED EDGE-TTS) ---
TTS_CACHE = {}  # Caches generated audio in RAM so repeat clicks play in 0ms

@app.route("/api/tts", methods=["GET", "POST"])
def text_to_speech():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        text = data.get("text", "").strip()
    else:
        text = request.args.get("text", "").strip()

    if not text:
        return jsonify({"error": "No text provided"}), 400

    # Return immediately if already cached in memory
    if text in TTS_CACHE:
        return Response(TTS_CACHE[text], mimetype="audio/mpeg")

    VOICE = "en-IN-PrabhatNeural"
    PITCH = "-16Hz"  # Deep Indian baritone bass
    RATE = "-6%"     # Natural authoritative speed

    async def generate_audio_bytes():
        communicate = edge_tts.Communicate(text=text, voice=VOICE, pitch=PITCH, rate=RATE)
        audio_stream = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_stream.write(chunk["data"])
        audio_stream.seek(0)
        return audio_stream.read()

    try:
        mp3_bytes = asyncio.run(generate_audio_bytes())
        if len(TTS_CACHE) > 100:
            TTS_CACHE.clear()
        TTS_CACHE[text] = mp3_bytes
        return Response(mp3_bytes, mimetype="audio/mpeg")
    except Exception as e:
        print(f"Edge-TTS Error: {e}")
        return jsonify({"error": "Voice synthesis failed"}), 500
    
    # Deep Indian Baritone configuration:
    # Options: "en-IN-PrabhatNeural" (Indian English Male) or "hi-IN-MadhurNeural" (Hindi/English Male)
    VOICE = "en-IN-PrabhatNeural"
    PITCH = "-18Hz"  # Deepens the bass resonance into a heavy baritone
    RATE = "-12%"    # Slows cadence for a measured, dramatic delivery

    async def generate_audio_bytes():
        communicate = edge_tts.Communicate(text=text, voice=VOICE, pitch=PITCH, rate=RATE)
        audio_stream = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_stream.write(chunk["data"])
        audio_stream.seek(0)
        return audio_stream.read()

    try:
        mp3_bytes = asyncio.run(generate_audio_bytes())
        return Response(mp3_bytes, mimetype="audio/mpeg")
    except Exception as e:
        print(f"Edge-TTS Error: {e}")
        return jsonify({"error": "Voice synthesis failed"}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)