# Sportpedia 2.0 — Editorial Sports Knowledge Engine

An upgraded redesign of `satyammaurya0110-dotcom/sportpedia` featuring a bold **Editorial Athletic Broadsheet** light theme + **Floodlight Night** dark theme, multi-token relevance C search core, Head-to-Head Versus Radar Arena, Interactive Sport Matchmaker, 8-Question Trivia Blitz, Voice Search, Audio Commentary Player, and Personal Sports Locker.

## What's Upgraded
- **Visual Identity & Dual Themes**: Replaced generic dark-blue glassmorphism with Warm Ivory & Stadium Emerald Editorial Print mode + toggleable Obsidian & Volt Lime Floodlight Night mode.
- **Upgraded C Search Engine (`search_engine.c`)**: Added multi-token relevance scoring (`score`), `--category` filtering, `qsort` ranking, and safe JSON string escaping while remaining 100% compatible with your existing `sports_corpus.txt`.
- **Upgraded Flask API (`app.py`)**: Retains `/api/register`, `/api/login`, `/api/logout`, `/api/me`, `/api/history`, `/api/tts`, and `/search`, and adds `/api/bookmarks`, `/api/categories`, `/api/random`, and query latency telemetry (`latency_ms`).
- **New Interactive Features**: Versus Arena (Chart.js 6-axis radar comparison), Sport Matchmaker quiz, Trivia Blitz with streak tracking, Sport Dossier modal, sticky Audio Commentary bar, and Locker JSON export.

## Quick Start
1. Keep your existing `sports_corpus.txt` in the project root.
2. Compile the upgraded C core:
   ```bash
   gcc -O2 search_engine.c -o search_engine
   ```
   *(On Windows MSVC: `cl /O2 search_engine.c /Fe:search_engine.exe`)*
3. Run Flask:
   ```bash
   pip install flask werkzeug edge-tts
   python app.py
   ```
