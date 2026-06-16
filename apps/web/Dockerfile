# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
# Same-origin: frontend gọi /api/... trên chính host của nó → để trống VITE_API_BASE.
# nginx (serve stage) sẽ proxy /api/ sang container api.
ENV VITE_API_BASE=""
RUN npm run build

# ---- serve stage ----
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
