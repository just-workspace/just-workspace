# Just Workspace 설치 관리자
#
# 빌드 — 문맥은 **리포 루트**다(번들에 실을 파일이 리포 여기저기에 있다):
#   docker build -f installer/Dockerfile -t just-workspace-installer:$(cat VERSION) .
# 무엇이 문맥에 들어가는지는 installer/Dockerfile.dockerignore 가 정한다(번들 원본과 installer/ 만).
#
# 실행 — docs/installer.md:
#   docker run -d --name jw-installer --restart unless-stopped -p 8443:8443 \
#     -v /var/run/docker.sock:/var/run/docker.sock -v /opt/just-workspace:/data \
#     -e JW_HOST_DIR=/opt/just-workspace just-workspace-installer:<버전>

FROM python:3.14-slim
WORKDIR /app

# docker CLI + compose 플러그인 — 호스트의 docker.sock 으로 명령을 보낸다(데몬은 들어 있지 않다)
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

# 번들 — compose·설정 템플릿·구역 선언·비밀값 표·버전을 리포에서 복사한다(목록은 app/bundle.py 의 MANIFEST).
COPY . /src
RUN python -m app.bundle build /src /app/bundle && rm -rf /src

# 받을 이미지의 저장소(네임스페이스 포함). 다른 곳에서 받으려면 빌드 인자나 실행할 때 -e JW_REGISTRY=… 로 바꾼다.
# localhost 를 주면 서버에 이미 있는(소스에서 빌드한) 이미지를 쓴다.
ARG JW_REGISTRY=ghcr.io/just-workspace
ENV JW_REGISTRY=${JW_REGISTRY} \
    JW_DATA_DIR=/data \
    JW_BUNDLE_DIR=/app/bundle \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# /storage: 보조 컨테이너가 새 저장소 볼륨을 이 자리에 붙이면 소유권(1000:1000 = backend 가 쓰는 사용자)을 물려받는다.
RUN mkdir -p /data /storage && chown 1000:1000 /storage \
    && printf '#!/bin/sh\nexec python -m app.cli "$@"\n' > /usr/local/bin/jw && chmod +x /usr/local/bin/jw

EXPOSE 8443
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import ssl,urllib.request;urllib.request.urlopen('https://127.0.0.1:8443/healthz',context=ssl._create_unverified_context())" || exit 1
CMD ["python", "-m", "app.server"]
