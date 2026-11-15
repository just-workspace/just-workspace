# ws-mailserver — docker-mailserver 공식 릴리스 위에 데비안 보안 갱신만 얹은 파생 이미지.
#
# 왜: 업스트림 릴리스(현재 base = 17.0.0-r2, 2026-11-14)가 나온 뒤 데비안 보안 공지(DSA-6526-1 dovecot,
#   DSA-6531-1 openssl 등)가 쌓였는데 새 릴리스가 아직 없다. edge 태그는 운영 금지라
#   릴리스 digest 를 고정한 채 보안 저장소(trixie-security) 패키지만 올린다.
#   rspamd 는 업스트림이 쓰는 rspamd 공식 저장소의 최신 안정판으로 함께 올린다.
# 다음 DMS 릴리스가 나오면 base digest 를 그 릴리스로 바꾸고 이 갱신이 비는지 확인한다.
FROM mailserver/docker-mailserver@sha256:6cd2d4dbfb41ce3b8108968d266fb41b950ad27220979c67bda8a31bd1f6611d
RUN apt-get update -qq \
    && PKGS="$(apt list --upgradable 2>/dev/null | awk -F/ '/-security|^rspamd\// {print $1}')" \
    && echo "upgrading: $PKGS" \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade \
         -o Dpkg::Options::=--force-confold $PKGS \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 라이선스 고지 — 이미지를 배포하면 고지도 함께 가야 한다. 세 파일은 빌드 문맥 밖(리포 루트)에 있어
# 이름 붙인 문맥 `licenses` 로 받는다: compose 의 build.additional_contexts, 직접 빌드할 때는
# `docker build --build-context licenses=<리포 루트> …`.
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/
