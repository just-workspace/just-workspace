# syntax=docker/dockerfile:1
# just-workspace-rbi-mirror — 격리 브라우저 "미러 모드" 세션 이미지. KasmVNC 없음: Chromium(데비안 패키지) + mirror-agent(Node 22).
#
# 대상(target)
#   prod(기본, 마지막 단계) — 운영. 하네스·테스트 페이지 없음.
#   dev                       — 개발·시험(MIRROR_DEV=1): /dev/ 하네스 + 127.0.0.1:7100 테스트 페이지(미믹·악성 페이지). 운영에 쓰지 않는다.
# 실행 잠금은 이미지가 아니라 backend/app/rbi/policy.py mirror_docker_create_args 가 건다
#   (--user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --dns 0.0.0.0 IPv6 끔 · 자원 상한 · tmpfs 만 쓰기).
# 버전 고정: 베이스 이미지(태그+digest)·데비안 패키지(정확한 버전)·npm(package-lock). 데비안 보안 갱신으로 옛 버전이 저장소에서 빠지면
#   빌드가 실패한다 — 의도된 것: build-arg 로 새 버전을 적고(docs/rbi.md "이미지 갱신") 다시 굽는다.
# 라이선스: rbi/mirror/THIRD_PARTY.md · 루트 THIRD_PARTY_LICENSES.md

ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# ── 1) 에이전트·하네스 빌드 ──
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY protocol ./protocol
COPY agent ./agent
COPY client ./client
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ── 2) 고정 폰트 묶음(원격 Chromium 이 쓰는 바로 그 파일 → WOFF2) ──
FROM ${NODE_IMAGE} AS fonts
ARG FONTS_LIBERATION2=2.1.5-1
ARG FONTS_DEJAVU=2.37-6
ARG FONTS_NOTO_CJK=1:20220127+repack1-1
ARG PY_FONTTOOLS=4.38.0-1+deb12u1
ARG PY_BROTLI=1.0.9-2+deb12u1
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-liberation2=${FONTS_LIBERATION2} fonts-dejavu-core=${FONTS_DEJAVU} fonts-noto-cjk=${FONTS_NOTO_CJK} \
      python3-fonttools=${PY_FONTTOOLS} python3-brotli=${PY_BROTLI} \
 && rm -rf /var/lib/apt/lists/*
COPY fonts/build_fonts.py /build_fonts.py
RUN python3 /build_fonts.py /out

# ── 3) 실행 베이스 ──
FROM ${NODE_IMAGE} AS base
ARG CHROMIUM_VERSION=156.0.8078.79-1~deb12u1
ARG FONTS_LIBERATION2=2.1.5-1
ARG FONTS_DEJAVU=2.37-6
ARG FONTS_NOTO_CJK=1:20220127+repack1-1
ARG IPROUTE2=6.1.0-3
ARG CA_CERTS=20250419~deb12u2
# 폰트는 이 셋만(원격이 쓸 수 있는 폰트 = 사용자 PC 가 받는 폰트). iproute2 는 reaper 의 뷰어 수 확인(ss)용.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium=${CHROMIUM_VERSION} chromium-common=${CHROMIUM_VERSION} \
      fonts-liberation2=${FONTS_LIBERATION2} fonts-dejavu-core=${FONTS_DEJAVU} fonts-noto-cjk=${FONTS_NOTO_CJK} \
      iproute2=${IPROUTE2} ca-certificates=${CA_CERTS} \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /etc/chromium/policies/managed \
 && fc-cache -f >/dev/null
WORKDIR /opt/mirror
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/agent/dist ./agent/dist
COPY --from=fonts /out ./fonts/dist
# 라이선스 고지 — 이미지를 배포하면 고지도 함께 가야 한다. 세 파일은 빌드 문맥 밖(리포 루트)에 있어
# 이름 붙인 문맥 `licenses` 로 받는다: compose 의 build.additional_contexts, 직접 빌드할 때는
# `docker build --build-context licenses=<리포 루트> …`.
# 디렉터리(/licenses)를 0755 로 먼저 생성한다 — `--chmod=0644` 는 신규 생성되는 상위 디렉터리에도 적용되어
# 실행 비트가 없는 디렉터리가 되고, 비루트 사용자가 고지 파일을 읽지 못한다. 파일은 다음 줄에서 0644 로 덮어쓴다.
COPY --from=licenses --chmod=0755 LICENSE /licenses/
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/
# 이 이미지의 npm·데비안 구성요소 고지
COPY --chmod=0644 THIRD_PARTY.md /licenses/THIRD_PARTY-rbi-mirror.md

# LANG: UTF-8 로캘이 없으면 Chromium 이 한글 이름 파일을 올리기에서 조용히 버린다 — 데비안 기본 C.UTF-8
ENV HOME=/home/node LANG=C.UTF-8 MIRROR_PORT=6901 MIRROR_CHROMIUM=/usr/bin/chromium MIRROR_FONTS=/opt/mirror/fonts/dist NODE_ENV=production
EXPOSE 6901
USER 1000:1000
CMD ["node", "/opt/mirror/agent/dist/agent/src/index.js"]

# ── dev: 하네스·테스트 페이지(시험 스택 전용) ──
FROM base AS dev
COPY --from=build /src/client/dist ./client/dist
COPY devpages ./devpages

# ── prod(기본) ──
FROM base AS prod
