FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# 7860 是 Hugging Face Spaces 的默认端口；Render 会通过 PORT 变量覆盖。
EXPOSE 7860
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-7860}"]
