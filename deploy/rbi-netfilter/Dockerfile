# ws-rbi-netfilter — 격리 브라우저(RBI) 세션 브리지의 호스트 iptables 규칙을 걸고 5초(RBI_POLL)마다 동적 허용 목록·어긋남을 확인하는 사이드카.
# 호스트 Docker 가 iptables-nft 를 쓰므로(Firewall Backend: iptables, nf_tables) 같은 백엔드를 가진 Debian 의
# iptables 를 쓴다(alpine 의 iptables 는 legacy 라 nft 쪽 DOCKER-USER 체인을 보지 못한다).
# network_mode: host + cap_add NET_ADMIN 만 필요하다. docker.sock 은 받지 않는다.
FROM debian:13-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends iptables iproute2 procps \
    && rm -rf /var/lib/apt/lists/*
COPY apply.sh /apply.sh
COPY rbi-allow-check.awk /rbi-allow-check.awk
RUN chmod +x /apply.sh

# 라이선스 고지 — 이미지 배포 시 고지를 함께 포함해야 한다. 세 파일은 빌드 컨텍스트 밖(리포 루트)에 있으므로
# 명명된 컨텍스트 `licenses` 로 전달받는다: compose 의 build.additional_contexts, 직접 빌드 시에는
# `docker build --build-context licenses=<리포 루트> …`.
# 디렉터리(/licenses)를 0755 로 먼저 생성한다 — `--chmod=0644` 는 신규 생성되는 상위 디렉터리에도 적용되어
# 실행 비트가 없는 디렉터리가 되고, 비루트 사용자가 고지 파일을 읽지 못한다. 파일은 다음 줄에서 0644 로 덮어쓴다.
COPY --from=licenses --chmod=0755 LICENSE /licenses/
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/
ENTRYPOINT ["/apply.sh"]
