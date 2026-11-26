FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8788
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8788}"]
