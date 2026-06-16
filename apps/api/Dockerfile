FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Copy toàn bộ source (cần cho editable install + alembic resolve path qua __file__).
COPY . .

# Editable install: giữ app package ở /app/app → lifespan tìm thấy /app/alembic.ini.
# bcrypt<4.0 đã pin trong pyproject (tránh lỗi "password > 72 bytes" của passlib 1.7.4).
RUN pip install --upgrade pip && pip install -e .

EXPOSE 8000

# Lifespan tự chạy `alembic upgrade head` + seed super-admin lúc startup.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
