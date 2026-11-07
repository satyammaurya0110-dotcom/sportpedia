# Use an official lightweight Python image
FROM python:3.9-slim

# Install the GCC compiler to build the C search engine binary
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Copy all project files into the container
COPY . /app

# Compile the C search engine binary for Linux
RUN gcc search_engine.c -o search_engine

# Install Flask, PostgreSQL adapter, and Edge Neural TTS
RUN pip install --no-cache-dir flask psycopg2-binary edge-tts

# Expose the application port
EXPOSE 5000

# Start the Flask backend server
CMD ["python", "app.py"]