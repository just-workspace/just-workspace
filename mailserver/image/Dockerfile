# ws-mailserver — docker-mailserver 공식 릴리스에 데비안 보안 갱신만 추가한 파생 이미지.
#
# 사유: 업스트림 릴리스(현재 base = 17.0.0-r2, 2026-11-14) 이후 데비안 보안 공지(DSA-6526-1 dovecot,
#   DSA-6531-1 openssl 등)가 누적되었으나 신규 릴리스가 아직 없다. edge 태그는 운영 사용 금지이므로
#   릴리스 digest 를 고정한 상태로 보안 저장소(trixie-security) 패키지만 갱신한다.
#   rspamd 는 업스트림이 사용하는 rspamd 공식 저장소의 최신 안정판으로 함께 갱신한다.
# 다음 DMS 릴리스가 나오면 base digest 를 해당 릴리스로 교체하고 이 갱신의 대상이 없어지는지 확인한다.
FROM mailserver/docker-mailserver@sha256:6cd2d4dbfb41ce3b8108968d266fb41b950ad27220979c67bda8a31bd1f6611d
RUN apt-get update -qq \
    && PKGS="$(apt list --upgradable 2>/dev/null | awk -F/ '/-security|^rspamd\// {print $1}')" \
    && echo "upgrading: $PKGS" \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade \
         -o Dpkg::Options::=--force-confold $PKGS \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 라이선스 고지 — 이미지 배포 시 고지를 함께 포함해야 한다. 세 파일은 빌드 컨텍스트 밖(리포 루트)에 있어
# 이름 있는 컨텍스트 `licenses` 로 전달받는다: compose 의 build.additional_contexts, 직접 빌드 시에는
# `docker build --build-context licenses=<리포 루트> …`.
# 디렉터리(/licenses)를 0755 로 먼저 생성한다 — `--chmod=0644` 는 신규 생성되는 상위 디렉터리에도 적용되어
# 실행 비트가 없는 디렉터리가 되고, 비루트 사용자가 고지 파일을 읽지 못한다. 파일은 다음 줄에서 0644 로 덮어쓴다.
COPY --from=licenses --chmod=0755 LICENSE /licenses/
COPY --from=licenses --chmod=0644 LICENSE NOTICE THIRD_PARTY_LICENSES.md /licenses/
