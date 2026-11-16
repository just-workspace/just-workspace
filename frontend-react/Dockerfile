# just-workspace 프런트(React) — 빌드 후 정적 서빙(포트 3000, SPA fallback).
# 번들 2종: 워크스페이스 앱(dist → 3000) · 격리 브라우저 단독 앱(dist-rbi → 3001, rbi 전용 출처 한정 — nginx/nginx.conf 의 rbi server 블록).
FROM node:26.13.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 빌드 시점의 이름·색(런타임 브랜딩은 /api/health 값으로 대체됨). VITE_API_BASE 는 번들 앱 빌드에서만 지정.
ARG APP_NAME=Workspace
ARG BRAND_COLOR=#3B82F6
ARG VITE_API_BASE=
ENV APP_NAME=$APP_NAME BRAND_COLOR=$BRAND_COLOR VITE_API_BASE=$VITE_API_BASE
RUN npm run build && npm run build:rbi

# 정적 서빙: 비특권 nginx(uid 101, 1024 미만 포트 미사용)
FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/dist-rbi /usr/share/nginx/rbi
# 라이선스 고지 — 이미지 배포 시 고지를 함께 포함해야 한다. 세 파일은 빌드 컨텍스트 밖(리포 루트)에 위치하므로
# 명명된 컨텍스트 `licenses` 로 전달한다: compose 의 build.additional_contexts, 직접 빌드 시
# `docker build --build-context licenses=<리포 루트> …`.
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/

EXPOSE 3000 3001
