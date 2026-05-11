FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install chromium --with-deps \
    && playwright install-deps chromium

COPY src/ ./src/

EXPOSE 3400

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -sf http://localhost:3400/health || exit 1

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "3400", "--workers", "1"]
