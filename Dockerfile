FROM python:3.9-slim
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
RUN gcc search_engine.c -o search_engine
RUN pip install --no-cache-dir flask
EXPOSE 5000
CMD ["python", "app.py"]