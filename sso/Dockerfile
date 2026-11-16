FROM python:3.14-slim

# pysaml2 는 pip 의존성 외에 xmlsec1 **시스템 바이너리**를 런타임에 호출한다.
# 없으면 서명/검증이 조용히 실패한다.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xmlsec1 libxmlsec1-openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# 베이스 이미지의 pip 은 설치 시점 취약점(경로 순회 계열)이 있어 먼저 최신으로 올린다.
RUN pip install --no-cache-dir -U pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# 라이선스 고지 — 이미지를 배포하면 고지도 함께 가야 한다. 세 파일은 빌드 문맥 밖(리포 루트)에 있어
# 이름 붙인 문맥 `licenses` 로 받는다: compose 의 build.additional_contexts, 직접 빌드할 때는
# `docker build --build-context licenses=<리포 루트> …`.
# 디렉터리(/licenses)를 0755 로 먼저 생성한다 — `--chmod=0644` 는 신규 생성되는 상위 디렉터리에도 적용되어
# 실행 비트가 없는 디렉터리가 되고, 비루트 사용자가 고지 파일을 읽지 못한다. 파일은 다음 줄에서 0644 로 덮어쓴다.
COPY --from=licenses --chmod=0755 LICENSE /licenses/
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/

# 비루트 실행
RUN useradd -u 10001 -m sso && chown -R sso:sso /app
USER sso

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
