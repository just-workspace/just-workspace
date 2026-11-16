# Just Workspace 설치 관리자
#
# 빌드 — 빌드 컨텍스트는 **리포 루트**이다(번들 포함 대상 파일이 리포 여러 위치에 분산되어 있음):
#   docker build -f installer/Dockerfile -t just-workspace-installer:$(cat VERSION) .
# 컨텍스트 포함 대상은 installer/Dockerfile.dockerignore 에서 정의한다(번들 원본, installer/, 설치 마법사 화면의 원본 frontend-react/).
#
# 실행 — docs/installer.md:
#   docker run -d --name jw-installer --restart unless-stopped -p 8443:8443 \
#     -v /var/run/docker.sock:/var/run/docker.sock -v /opt/just-workspace:/data \
#     -e JW_HOST_DIR=/opt/just-workspace just-workspace-installer:<버전>

# ─── 설치 마법사 화면 — frontend-react 의 독립 번들(본 앱 이미지와 동일한 Node·동일한 lock) ───
FROM node:26.13.1-alpine AS ui
WORKDIR /ui
COPY frontend-react/package.json frontend-react/package-lock.json ./
RUN npm ci
COPY frontend-react/ ./
RUN npm run build:installer

FROM python:3.14-slim
WORKDIR /app

# docker CLI 및 compose 플러그인. 호스트의 docker.sock 으로 명령을 전달한다(데몬 미포함)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update -qq && apt-get install -y -qq --no-install-recommends docker-ce-cli docker-compose-plugin \
    && apt-get purge -y -qq curl && apt-get autoremove -y -qq && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir -U pip
COPY installer/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY installer/app/ /app/app/

# 채널·릴리스 목록 검증 — 릴리스 도구의 모듈을 그대로 사용한다(복제 금지. docs/releases.md 맨 아래)
COPY release/jwrelease/__init__.py release/jwrelease/semver.py release/jwrelease/model.py release/jwrelease/verify.py \
     release/jwrelease/bundle.py release/jwrelease/sign.py release/jwrelease/config.py /app/jwrelease/
# 채널 서명 검증용 공개 키(*.pub, 최대 2개 — 현재·다음). 리포에는 키를 포함하지 않으며, 릴리스 빌드가 이 폴더에 배치한다.
# 비어 있으면 업데이트 확인은 "구성되지 않음"으로 응답한다. 설치 후 상태 폴더(update/keys/)에 추가하는 것도 가능하다.
COPY installer/keys/ /app/keys/

# 설치 마법사 화면(installer.html · assets/ · icon.svg) — 설치 관리자가 8443 의 / 에서 제공
COPY --from=ui /ui/dist-installer/ /app/ui/

# 번들 — compose·설정 템플릿·구역 선언·비밀값 표·버전을 리포에서 복사한다(목록은 app/bundle.py 의 MANIFEST).
COPY . /src
RUN python -m app.bundle build /src /app/bundle && rm -rf /src

# 라이선스 고지 — 이미지 배포 시 고지 동반 필수(빌드 컨텍스트가 리포 루트이므로 직접 복사)
COPY --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/

# pull 대상 이미지의 저장소(네임스페이스 포함). 변경 시 빌드 인자 또는 실행 시 -e JW_REGISTRY=… 로 지정한다.
# localhost 지정 시 서버에 이미 존재하는(소스에서 빌드한) 이미지를 사용한다.
ARG JW_REGISTRY=ghcr.io/just-workspace
# 채널 파일 수신 기준 주소 — 미지정 시 릴리스 도구의 기본값 적용(release/jwrelease/config.py 의 channel_base_url)
ARG JW_UPDATE_CHANNEL_URL=
ENV JW_REGISTRY=${JW_REGISTRY} \
    JW_UPDATE_CHANNEL_URL=${JW_UPDATE_CHANNEL_URL} \
    JW_UPDATE_PUBKEY_DIR=/app/keys \
    JW_DATA_DIR=/data \
    JW_BUNDLE_DIR=/app/bundle \
    JW_UI_DIR=/app/ui \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# /storage: 보조 컨테이너가 신규 저장소 볼륨을 이 위치에 마운트하면 소유권(1000:1000 = backend 실행 사용자)을 상속한다.
RUN mkdir -p /data /storage && chown 1000:1000 /storage \
    && printf '#!/bin/sh\nexec python -m app.cli "$@"\n' > /usr/local/bin/jw && chmod +x /usr/local/bin/jw

EXPOSE 8443
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import ssl,urllib.request;urllib.request.urlopen('https://127.0.0.1:8443/healthz',context=ssl._create_unverified_context())" || exit 1
CMD ["python", "-m", "app.server"]
