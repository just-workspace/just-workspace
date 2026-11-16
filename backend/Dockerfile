# 대상(stage) 3종:
#   base     공통 단계. 아래 두 단계의 기반
#   test     base + 테스트 도구(requirements-dev.txt). 테스트 코드는 포함하지 않으며 리포를 마운트하여 실행한다(CONTRIBUTING.md)
#   runtime  운영 이미지. 마지막 단계이므로 `--target` 없이 빌드하면 본 단계가 산출된다. 릴리스 대상은 본 단계뿐이다
FROM python:3.14-slim AS base
WORKDIR /app

# Docker CLI (for docker exec to manage mailserver accounts)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    ca-certificates curl \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update -qq && apt-get install -y -qq --no-install-recommends docker-ce-cli gosu \
    && apt-get install -y -qq --no-install-recommends pandoc \
    && rm -rf /var/lib/apt/lists/*
# pandoc: 네이티브 문서(.jwdoc)의 HTML 정본을 docx/pdf/md 로 내보내고, 받은 docx 를
#         가져올 때 쓴다. 자체 포맷에 갇히지 않게 하는 핵심 조각.

# 베이스 이미지의 pip 에는 설치 시점 취약점(경로 순회 계열)이 존재하므로 먼저 최신 버전으로 갱신한다.
RUN pip install --no-cache-dir -U pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# 제품 버전 — 빌드 시 리포 루트 VERSION 의 값을 전달한다(--build-arg JW_APP_VERSION="$(cat VERSION)").
# 미전달 시 파일을 생성하지 않으며, 앱은 개발 표기(0.0.0-dev)로 기동한다(app/version.py).
ARG JW_APP_VERSION=
RUN if [ -n "$JW_APP_VERSION" ]; then echo "$JW_APP_VERSION" > /app/VERSION; fi

RUN groupadd -g 1001 docker || true \
    && useradd -m -u 1000 -G 1001 appuser \
    && chown -R appuser:appuser /app \
    && mkdir -p /storage /backups /plugins-data /run/rbi-allow && chown appuser:appuser /storage /backups /plugins-data /run/rbi-allow
# /storage 를 appuser 소유로 생성 → 신규 named volume 최초 마운트 시 해당 소유권을 상속(루트 소유 생성에 따른 권한 오류 방지)

# 라이선스 고지 — 이미지 배포 시 고지를 함께 포함해야 한다. 세 파일은 빌드 컨텍스트 밖(리포 루트)에 있으므로
# 명명된 컨텍스트 `licenses` 로 수신한다: compose 의 build.additional_contexts, 직접 빌드 시에는
# `docker build --build-context licenses=<리포 루트> …`.
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/

# 루트로 기동 → entrypoint 가 docker.sock gid 정렬 후 gosu 로 appuser 로 강등
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
# 신뢰 프록시 = ws-nginx 고정 IP(172.28.0.2). docker-compose.yml 의 command 와 동일하게 유지한다(R7 A2).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "172.28.0.2", "--timeout-graceful-shutdown", "5"]


# ── 테스트 대상 — pytest 계열 및 aiosqlite 추가 ──
#   docker build --target test --build-context licenses=<리포 루트> -t <이름> backend
FROM base AS test
COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt


# ── 운영 대상(기본) ──
FROM base AS runtime
