FROM python:3.14-slim
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

# 베이스 이미지의 pip 은 설치 시점 취약점(경로 순회 계열)이 있어 먼저 최신으로 올린다.
RUN pip install --no-cache-dir -U pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# 제품 버전 — 빌드할 때 리포 루트 VERSION 의 값을 넘긴다(--build-arg JW_APP_VERSION="$(cat VERSION)").
# 넘기지 않으면 파일을 만들지 않고, 앱은 개발 표기(0.0.0-dev)로 뜬다(app/version.py).
ARG JW_APP_VERSION=
RUN if [ -n "$JW_APP_VERSION" ]; then echo "$JW_APP_VERSION" > /app/VERSION; fi

RUN groupadd -g 1001 docker || true \
    && useradd -m -u 1000 -G 1001 appuser \
    && chown -R appuser:appuser /app \
    && mkdir -p /storage /backups /plugins-data /run/rbi-allow && chown appuser:appuser /storage /backups /plugins-data /run/rbi-allow
# /storage 를 appuser 소유로 만들어 둠 → 신규 named volume 첫 마운트 시 이 소유권을 상속(루트 소유로 생기는 권한오류 방지)

# 라이선스 고지 — 이미지를 배포하면 고지도 함께 가야 한다. 두 파일은 빌드 문맥 밖(리포 루트)에 있어
# 이름 붙인 문맥 `licenses` 로 받는다: compose 의 build.additional_contexts, 직접 빌드할 때는
# `docker build --build-context licenses=<리포 루트> …`.
COPY --from=licenses --chmod=0644 LICENSE THIRD_PARTY_LICENSES.md /licenses/

# 루트로 시작 → entrypoint가 docker.sock gid 정렬 후 gosu로 appuser 강등
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
# 신뢰 프록시 = ws-nginx 고정 IP(172.28.0.2) — docker-compose.yml 의 command 와 같게 둔다(R7 A2).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "172.28.0.2", "--timeout-graceful-shutdown", "5"]
