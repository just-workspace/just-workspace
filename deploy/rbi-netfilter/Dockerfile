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
ENTRYPOINT ["/apply.sh"]
