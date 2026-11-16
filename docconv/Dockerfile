# ws-docconv — LibreOffice headless 문서 변환(docx/xlsx/pptx/odt/hwp/hwpx → pdf, docx↔odt 등)
#
# * LibreOffice: Debian 13(trixie) 백포트의 최신판(26.8 계열). GUI 없는 -nogui 패키지만 설치.
# * HWP/HWPX: H2Orestart(오픈소스 LibreOffice 확장, GPL-3.0, https://github.com/ebandal/H2Orestart) —
#   Java 확장이므로 JRE 가 필요하다. 별도 컨테이너 안에서 LibreOffice 확장으로만 사용되며 본 프로젝트 코드와 링크되지 않는다.
#   H2ORESTART_VERSION 을 비우면 설치하지 않는다(이 경우 hwp/hwpx 변환은 실패를 반환한다).
# * 네트워크 없음(compose network_mode: none) — 백엔드와는 공유 볼륨의 유닉스 소켓으로만 통신.
# * 비루트(10001), 읽기 전용 루트(compose read_only) — 쓰기는 /tmp(tmpfs)와 소켓 볼륨에 한정.
FROM debian:trixie-slim

ARG H2ORESTART_VERSION=v0.8.0
ARG DEBIAN_FRONTEND=noninteractive

RUN echo "deb http://deb.debian.org/debian trixie-backports main" > /etc/apt/sources.list.d/backports.list \
    && apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends -t trixie-backports \
         libreoffice-core-nogui libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
         libreoffice-java-common \
         default-jre-headless python3 ca-certificates curl \
         fonts-noto-cjk fonts-nanum fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*

# H2Orestart(HWP·HWPX 가져오기 필터) — 모든 사용자 프로필에서 사용할 수 있도록 --shared 설치
RUN set -eux; \
    if [ -n "${H2ORESTART_VERSION}" ]; then \
      curl -fsSL -o /tmp/H2Orestart.oxt \
        "https://github.com/ebandal/H2Orestart/releases/download/${H2ORESTART_VERSION}/H2Orestart.oxt"; \
      HOME=/tmp unopkg add --shared --suppress-license /tmp/H2Orestart.oxt; \
      rm -f /tmp/H2Orestart.oxt; rm -rf /tmp/.config /tmp/*.log || true; \
    fi; \
    apt-get purge -y -qq curl && apt-get autoremove -y -qq && rm -rf /var/lib/apt/lists/*

# 작업마다 복사해 사용할 사용자 프로필 템플릿(첫 실행 초기화 비용을 이미지 빌드 시 1회만 부담)
RUN useradd -u 10001 -m -d /home/docconv docconv \
    && mkdir -p /opt/lo-profile /run/docconv \
    && HOME=/tmp soffice --headless --norestore --nologo --terminate_after_init \
         "-env:UserInstallation=file:///opt/lo-profile" || true \
    && chown -R docconv:docconv /opt/lo-profile /run/docconv \
    && chmod 0755 /run/docconv \
    && rm -rf /tmp/* /tmp/.[!.]* || true

COPY server.py /opt/docconv/server.py

# 라이선스 고지 — 이미지 배포 시 고지를 함께 포함해야 한다. 세 파일은 빌드 컨텍스트 밖(리포 루트)에 있으므로
# 명명된 컨텍스트 `licenses` 로 전달받는다: compose 의 build.additional_contexts, 직접 빌드 시에는
# `docker build --build-context licenses=<리포 루트> …`.
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/

USER 10001:10001
ENV DOCCONV_LISTEN=unix:/run/docconv/docconv.sock \
    DOCCONV_PROFILE_TEMPLATE=/opt/lo-profile \
    HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["python3", "/opt/docconv/server.py", "--health"]
ENTRYPOINT ["python3", "/opt/docconv/server.py"]
