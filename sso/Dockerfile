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

# 비루트 실행
RUN useradd -u 10001 -m sso && chown -R sso:sso /app
USER sso

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
