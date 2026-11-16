# ws-sandbox — 격리 Python 분석 실행(code_run 도구)
#
# 격리는 compose 설정과 결합되어 완성된다(docker-compose.yml 의 sandbox 항목):
#   network_mode: none · read_only · tmpfs /tmp · cap_drop ALL + (SETUID SETGID CHOWN KILL) · no-new-privileges ·
#   mem/cpu/pids 상한. 서버는 root 로 기동하여 요청마다 슬롯별 비루트 uid(20001~)로 권한을 낮춰 코드를 실행한다.
FROM python:3.14-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends fonts-nanum fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir -U pip
COPY requirements.txt /opt/sandbox/requirements.txt
RUN pip install --no-cache-dir -r /opt/sandbox/requirements.txt \
    && pip uninstall -y pip setuptools wheel 2>/dev/null || true

COPY matplotlibrc /opt/sandbox/matplotlibrc
COPY server.py helpers.py /opt/sandbox/

# 라이선스 고지 — 이미지 배포 시 고지를 함께 포함해야 한다. 세 파일은 빌드 문맥 밖(리포 루트)에 있으므로
# 명명된 문맥 `licenses` 로 전달받는다: compose 의 build.additional_contexts, 직접 빌드 시에는
# `docker build --build-context licenses=<리포 루트> …`.
# 디렉터리(/licenses)를 0755 로 먼저 생성한다 — `--chmod=0644` 는 신규 생성되는 상위 디렉터리에도 적용되어
# 실행 비트가 없는 디렉터리가 되고, 비루트 사용자가 고지 파일을 읽지 못한다. 파일은 다음 줄에서 0644 로 덮어쓴다.
COPY --from=licenses --chmod=0755 LICENSE /licenses/
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/

# 슬롯별 실행 계정(로그인 없음). 글꼴 캐시는 이미지에 사전 생성하고 작업마다 복사한다.
RUN set -eux; \
    for i in 0 1 2 3 4 5 6 7; do uid=$((20001 + i)); \
      groupadd -g "$uid" "sbx$i"; useradd -u "$uid" -g "$uid" -M -d /nonexistent -s /usr/sbin/nologin "sbx$i"; done; \
    mkdir -p /opt/sandbox/mplcache /run/sandbox; \
    MPLCONFIGDIR=/opt/sandbox/mplcache MATPLOTLIBRC=/opt/sandbox/matplotlibrc \
      python -c "import matplotlib.font_manager as fm; fm._load_fontmanager(try_read_cache=False)"; \
    chmod -R a+rX /opt/sandbox; \
    python -m compileall -q /opt/sandbox

ENV SANDBOX_LISTEN=unix:/run/sandbox/sandbox.sock \
    PYTHONDONTWRITEBYTECODE=1
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["python", "/opt/sandbox/server.py", "--health"]
ENTRYPOINT ["python", "-I", "/opt/sandbox/server.py"]
