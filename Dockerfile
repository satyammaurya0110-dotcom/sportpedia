FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*
COPY . .
RUN gcc -O2 search_engine.c -o search_engine
RUN pip install --no-cache-dir flask werkzeug edge-tts psycopg2-binary gunicorn
EXPOSE 5000
CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app"]
