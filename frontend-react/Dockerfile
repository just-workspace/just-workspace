# just-workspace 프런트(React) — 빌드 후 정적 서빙(포트 3000, SPA fallback).
# 두 번들: 워크스페이스 앱(dist → 3000) · 격리 브라우저 단독 앱(dist-rbi → 3001, rbi 전용 출처만 — nginx/nginx.conf 의 rbi server 블록).
FROM node:26.13.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 빌드 때 이름·색(런타임 브랜딩은 /api/health 가 덮는다). 번들 앱 빌드만 VITE_API_BASE 를 준다.
ARG APP_NAME=Workspace
ARG BRAND_COLOR=#3B82F6
ARG VITE_API_BASE=
ENV APP_NAME=$APP_NAME BRAND_COLOR=$BRAND_COLOR VITE_API_BASE=$VITE_API_BASE
RUN npm run build && npm run build:rbi

# 정적 서빙: 비특권 nginx(uid 101, 포트 1024 미만을 쓰지 않음)
FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/dist-rbi /usr/share/nginx/rbi
EXPOSE 3000 3001
