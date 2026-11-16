FROM python:3.14-slim

# pysaml2 는 pip 의존성 외에 xmlsec1 **시스템 바이너리**를 런타임에 호출한다.
# 없으면 서명/검증이 오류 표시 없이 실패한다.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xmlsec1 libxmlsec1-openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# 베이스 이미지의 pip 에는 설치 시점 취약점(경로 순회 계열)이 있으므로 먼저 최신 버전으로 갱신한다.
RUN pip install --no-cache-dir -U pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# 라이선스 고지 — 이미지 배포 시 고지를 함께 포함해야 한다. 세 파일은 빌드 문맥 밖(리포 루트)에 있으므로
# 명명된 문맥 `licenses` 로 전달받는다: compose 의 build.additional_contexts, 직접 빌드 시에는
# `docker build --build-context licenses=<리포 루트> …`.
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/

# 비루트 실행
RUN useradd -u 10001 -m sso && chown -R sso:sso /app
USER sso

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
