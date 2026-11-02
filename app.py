from flask import Flask, app, render_template, request, jsonify
app = Flask(__name__)
import subprocess
import json
import os

# Inside your search route function, make sure ENGINE_PATH is:
ENGINE_PATH = "./search_engine"
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/search")
def search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify([])

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

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)