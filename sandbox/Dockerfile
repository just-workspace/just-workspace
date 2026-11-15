# ws-sandbox — 격리 Python 분석 실행(code_run 도구)
#
# 격리는 compose 설정과 함께 완성된다(docker-compose.yml 의 sandbox 항목):
#   network_mode: none · read_only · tmpfs /tmp · cap_drop ALL + (SETUID SETGID CHOWN KILL) · no-new-privileges ·
#   mem/cpu/pids 상한. 서버는 root 로 떠서 요청마다 슬롯별 비루트 uid(20001~)로 내려 코드를 돌린다.
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

# 슬롯별 실행 계정(로그인 없음). 글꼴 캐시는 이미지에 미리 만들어 두고 작업마다 복사한다.
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
