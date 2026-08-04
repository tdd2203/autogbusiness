FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# ---- Tối ưu RAM (2026-08-04) ----
# Mọi endpoint FastAPI ở đây khai báo `def` (sync) nên chạy trong threadpool →
# process này luôn nhiều thread. glibc cấp một "arena" malloc RIÊNG cho từng
# thread, mỗi arena giữ lại vùng nhớ đã free để tái dùng → RSS phồng lên mà
# không phải do dữ liệu thật đang sống. Ép về 2 arena (đủ tránh contention).
# MALLOC_TRIM_THRESHOLD_ (có gạch dưới cuối — đúng tên biến của glibc): cố định
# ngưỡng trả nhớ về OS ở 128KB, chặn glibc tự nâng ngưỡng lên rất cao sau các
# request nặng rồi giữ khư khư phần nhớ đó.
ENV MALLOC_ARENA_MAX=2 \
    MALLOC_TRIM_THRESHOLD_=131072

WORKDIR /app

# ---- Cache tầng dependency (2026-08-04) ----
# Trước đây `COPY . .` đứng TRƯỚC `pip install` → sửa 1 dòng Python là vỡ cache,
# mỗi lần deploy VPS tải + cài lại TOÀN BỘ dependency (tốn phút, và là một đỉnh
# RAM nữa trên VPS nhỏ). Tách đôi: cài dependency từ pyproject với package RỖNG
# trước — tầng này chỉ vỡ khi `pyproject.toml` đổi — rồi mới copy source thật.
# Editable install trỏ thẳng vào /app/app nên source copy sau có hiệu lực ngay,
# KHÔNG cần cài lại. Sửa pyproject ⇒ tự cài lại, không cần nhớ xoá cache tay.
COPY pyproject.toml ./
RUN mkdir -p app && touch app/__init__.py \
    && pip install --upgrade pip && pip install -e .

# Copy toàn bộ source (cần cho editable install + alembic resolve path qua __file__).
# Đè lên package rỗng ở trên; COPY không xoá file nên egg-info của bước cài vẫn còn.
# bcrypt<4.0 đã pin trong pyproject (tránh lỗi "password > 72 bytes" của passlib 1.7.4).
COPY . .

EXPOSE 8000

# Lifespan tự chạy `alembic upgrade head` + seed super-admin lúc startup.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
