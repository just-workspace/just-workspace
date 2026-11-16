FROM python:3.14-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
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

RUN useradd -u 10002 -m ldapsvc && chown -R ldapsvc:ldapsvc /app

# LDAPS 자체 서명 인증서 보관 디렉터리.
# ★ 이미지 안에서 **미리 만들고 소유권을 잡아야** 한다. 명명 볼륨은 최초 마운트 시
#   이미지의 해당 경로 권한을 상속하는데, 디렉터리가 없으면 root 소유로 생성돼
#   비루트 프로세스가 쓰지 못한다(Permission denied).
RUN mkdir -p /certs && chown ldapsvc:ldapsvc /certs && chmod 700 /certs

USER ldapsvc

# 389 은 특권포트라 비루트로 못 연다. 컨테이너 안에서는 1389 를 쓰고
# compose 에서 389:1389 로 매핑한다.
EXPOSE 1389
CMD ["python", "-m", "app.server"]
