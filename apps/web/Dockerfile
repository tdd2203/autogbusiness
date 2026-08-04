# SERVE-ONLY — không còn build stage (tối ưu RAM 2026-08-04).
#
# Trước đây image này tự chạy `npm install` + `vite build` bên trong Docker. Vì
# `scripts/deploy-server.sh` gọi `docker compose build web` TRÊN VPS, bước đó là
# ĐỈNH RAM lớn nhất của cả hệ thống (Node + rollup + tsc thường ngốn 1–2GB) —
# gấp nhiều lần RAM lúc chạy bình thường, và là nguyên nhân dễ OOM nhất lúc deploy.
#
# Giờ `dist/` được build ở MÁY DEV rồi mang lên: deploy-all.sh và deploy-server.sh
# đều tự chạy `npm run build` trước khi build image / rsync. Build image chỉ còn
# là copy file → gần như không tốn RAM.
#
# Build tay khi cần:  cd apps/web && npm run build
# Thiếu dist/ → docker build FAIL ngay ở dòng COPY (không im lặng serve bản cũ).
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html
EXPOSE 80
