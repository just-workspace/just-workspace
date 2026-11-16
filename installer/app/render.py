"""렌더링 — 답변 + 비밀값 + 감지값 → 스택 파일 내용.

순수 함수다(파일·네트워크·시계·난수를 건드리지 않는다). 같은 입력이면 같은 출력이 나온다.

    plan  = derive(answers, facts, catalog)            # 파생값(구역·프로파일·포트·이름·주의)
    files = render(answers, secrets, facts, bundle)     # {스택 안 상대 경로: 내용}

`secrets` 는 `.env` 에 들어가는 비밀값과 설치 관리자가 관리하는 값이다.
- backend 의 비밀값 표에 있는 이름(SECRET_KEY, DB_PASSWORD …)
- `SMTP_PASSWORD`(내장 메일의 발신 계정), `JW_INSTALLER_KEY`(내부 API 키), `JW_INSTALL_ID`
- `DKIM_PRIVATE_KEY`(PEM — 메일 레코드 확인 화면에서 미리 만든 것)
- 구역 훅이 채우는 값(`GITEA_TOKEN`, `OAUTH_CLIENTS_JSON`)

경로는 모두 **스택 폴더 기준 상대 경로**다(컨테이너 안 `/data/stack/…`, 호스트 `$JW_HOST_DIR/stack/…`).
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
from dataclasses import dataclass, field

from app import envfile
from app import validators as v
from app.answers import Answers, Facts, selected_zones
from app.bundle import STACK_COPIES, Bundle
from app.catalog import Catalog
from app.paths import SITE_COMPOSE
from app.update_release import source_url_override

HAIRPIN_OFF = "hairpin-off.invalid"
TURN_TLS_PORT_STANDALONE = 5349      # nginx 가 443 을 쓰는 서버에서 TURN/TLS 를 게시하는 호스트 포트
INTERNAL_API_PORT = 8444             # 설치 관리자 내부 API(워크스페이스 내부망 전용)
INSTALLER_ALIAS = "jw-installer"
DKIM_SELECTOR = "default"
# 복원한 설치에서, 백업의 `.env` 에서 그대로 옮겨 온 값들을 담아 두는 자리(`env.secret.json` 안의 사전 하나).
# 설치 관리자가 스스로 쓰는 변수 가운데서는 `CARRIED_ENV` 만 이 값으로 바꾸고, 다루지 않는 변수는 끝에 덧붙인다.
EXTRA_ENV_KEY = "_extra_env"
CARRIED_ENV = ("APP_NAME", "DOMAIN", "ADMIN_EMAILS")
CERT_ROOT = "/etc/letsencrypt/live"
SITE_CA_FILE = "site-ca/ca.pem"                         # 스택 폴더 기준 — 올린 인증서의 발급 CA(함께 온 체인 + 따로 올린 CA, 적용 엔진이 쓴다)
SITE_CA_MOUNT = "/etc/ssl/certs/jw-site-ca.pem"         # 컨테이너 안 — 코드 저장소는 시스템 CA 폴더의 파일로 읽고, backend 는 시작할 때 묶음에 더한다
SITE_CA_SERVICES = ("gitea", "backend")                 # 접속 주소(와 같은 CA 의 주소)로 HTTPS 요청을 보내는 우리 쪽 컨테이너

# 권한이 600 이어야 하는 파일 / 실행 권한이 필요한 파일
SECRET_FILES = (".env", "mailserver/config/dovecot-masters.cf", "mailserver/config/postfix-accounts.cf",
                "mailserver/config/rspamd/dkim/default.private")
# 이미 있으면 줄 단위로 합치는 파일(메일 계정은 운영 중에 백엔드가 덧붙인다)
MERGE_FILES = ("mailserver/config/postfix-accounts.cf",)


def file_mode(path: str) -> int:
    if path in SECRET_FILES:
        return 0o600
    if path.endswith(".sh"):
        return 0o755
    return 0o644


@dataclass
class Plan:
    zones: list[str]
    profiles: list[str]
    ports: list[str]
    domain: str                 # 접속 주소
    env_domain: str             # .env 의 DOMAIN(계정 메일 주소의 도메인)
    app_url: str
    tls: bool                   # 내장 nginx 가 TLS 를 끝낸다
    cert_mode: str
    cert_dir: str               # nginx 가 읽는 인증서 폴더 이름(= 접속 주소)
    cert_names: list[str]       # 인증서에 들어가야 하는 이름(첫 번째가 폴더 이름)
    cert_aliases: list[str]     # 같은 인증서를 가리키게 할 폴더 이름(서비스마다 찾는 자리가 다르다)
    net_prefix: str
    mail_builtin: bool
    mail_domain: str
    turn: bool
    turn_domain: str
    turn_tls_publish: str
    lossless: bool
    hairpin_host: str
    rp_lan_ip: str
    cautions: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def derive(answers: Answers, facts: Facts, catalog: Catalog) -> Plan:
    zones = selected_zones(answers, catalog)
    a = answers.access
    domain = a.domain
    is_ip = bool(domain) and v.is_ip(domain)
    proxy = a.network == "proxy"
    tls = not proxy
    cautions: list[dict] = []

    mail_on = "mail" in zones
    mail_builtin = mail_on and answers.mail.kind == "builtin"
    mail_domain = (answers.mail.mail_domain or domain) if mail_builtin else ""
    env_domain = mail_domain or domain
    meetings_on = "meetings" in zones
    turn = meetings_on and answers.meetings.turn and not is_ip
    lossless = meetings_on and answers.meetings.lossless_audio and "chat" in zones
    net_prefix = v.net_prefix(answers.advanced.subnet)

    # ── compose 프로파일 ──
    profiles = catalog.profiles(zones)
    if mail_on and not mail_builtin and "mailserver" in profiles:
        profiles.remove("mailserver")
    if meetings_on and not lossless and "audiorelay" in profiles:
        profiles.remove("audiorelay")
    if a.cert == "auto" and tls:
        profiles.append("certbot")

    # ── 호스트에 여는 포트 ──
    ports = catalog.ports(zones)

    def drop(*names: str) -> None:
        for name in names:
            if name in ports:
                ports.remove(name)

    if proxy:
        drop("443/tcp")
    # 평문 LDAP(389)은 이 서버 자신(루프백)에만 연다(LDAP_PLAIN_BIND=127.0.0.1) — 밖으로 여는 포트가 아니다
    drop("389/tcp")
    if mail_on and not mail_builtin:
        drop(*catalog.get("mail").get("ports", []))
    if meetings_on:
        if not lossless:
            drop("4433/udp")
        if turn:
            turn_port = "443/tcp" if proxy else f"{TURN_TLS_PORT_STANDALONE}/tcp"
            if turn_port not in ports:
                ports.append(turn_port)
        else:
            drop("3478/udp")

    # ── 인증서 이름 ──
    cert_names = [domain]
    cert_aliases: list[str] = []
    if not is_ip:
        if mail_builtin:
            cert_names.append(f"mail.{mail_domain}")
            cert_aliases.append(f"mail.{mail_domain}")
        if turn:
            cert_names.append(f"turn.{domain}")
            cert_aliases.append(f"turn.{domain}")
        if "rbi" in zones:
            cert_names.append(f"rbi.{domain}")

    # ── 컨테이너가 접속 주소로 되돌아올 때의 우회 ──
    if is_ip or not domain:
        hairpin_host, rp_lan_ip = HAIRPIN_OFF, ""
    elif tls:
        hairpin_host, rp_lan_ip = domain, f"{net_prefix}.2"        # 내장 nginx 가 443 을 듣는다
    else:
        singles = [p for p in a.proxy_addresses if "/" not in p]
        if facts.proxy_lan_ip:
            hairpin_host, rp_lan_ip = domain, facts.proxy_lan_ip
        elif len(a.proxy_addresses) == 1 and singles:
            hairpin_host, rp_lan_ip = domain, singles[0]
        else:
            hairpin_host, rp_lan_ip = HAIRPIN_OFF, ""
            if {"git", "docs"} & set(zones):
                cautions.append({"key": "hairpin_not_configured", "vars": {"domain": domain}})

    # ── 주의 모음 ──
    if a.cert == "temporary":
        cautions.append({"key": "cert_temporary", "vars": {"domain": domain}})
        if "git" in zones:
            cautions.append({"key": "git_sso_needs_trusted_cert", "vars": {}})
    if a.network == "router":
        cautions.append({"key": "router_port_forward", "vars": {"ports": list(ports)}})
    if proxy and (mail_builtin or turn):
        names = [n for n in cert_names[1:] if not n.startswith("rbi.")]
        cautions.append({"key": "proxy_side_certs_self_signed", "vars": {"names": names}})
    if turn and tls:
        cautions.append({"key": "turn_tls_alternate_port", "vars": {"port": TURN_TLS_PORT_STANDALONE}})
    if mail_builtin:
        cautions.append({"key": "mail_needs_dns_and_port25", "vars": {"mail_domain": mail_domain}})
        if mail_domain != domain:
            cautions.append({"key": "account_domain_is_mail_domain", "vars": {"mail_domain": mail_domain}})
    if not mail_on:
        cautions.append({"key": "no_system_mail", "vars": {}})
    if meetings_on and not (answers.meetings.public_ip or facts.public_ip):
        cautions.append({"key": "meetings_public_ip_unknown", "vars": {}})
    if lossless:
        cautions.append({"key": "lossless_needs_udp_4433", "vars": {}})
    if "rbi" in zones and not is_ip:
        cautions.append({"key": "rbi_needs_dns", "vars": {"name": f"rbi.{domain}"}})
    if facts.dns_status == "mismatch" and a.cert == "auto":
        cautions.append({"key": "dns_mismatch_cert_will_fail", "vars": {"domain": domain}})

    return Plan(
        zones=zones, profiles=profiles, ports=ports, domain=domain, env_domain=env_domain,
        app_url=f"https://{domain}" if domain else "", tls=tls, cert_mode=a.cert, cert_dir=domain,
        cert_names=cert_names, cert_aliases=cert_aliases, net_prefix=net_prefix,
        mail_builtin=mail_builtin, mail_domain=mail_domain, turn=turn,
        turn_domain=f"turn.{domain}" if turn else "",
        turn_tls_publish=("443" if proxy else str(TURN_TLS_PORT_STANDALONE)),
        lossless=lossless, hairpin_host=hairpin_host, rp_lan_ip=rp_lan_ip, cautions=cautions,
    )


# ─── .env ───


def backend_workers(facts: Facts) -> str:
    """워커 수 — backend entrypoint 와 같은 규칙(min 8, max 2, 코어 수). 메모리가 6GB 미만이면 2."""
    if not facts.cpus:
        return ""
    workers = min(8, max(2, int(facts.cpus)))
    if facts.memory_mb and facts.memory_mb < 6 * 1024:
        workers = 2
    return str(workers)


# 격리 브라우저의 대상이 될 수 있는 대역(backend 의 RBI_ALLOW_CEILING 기본값과 같다)
_RBI_PRIVATE = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def rbi_protected(facts: Facts) -> str:
    """`RBI_PROTECTED` — 이 서버의 주소와 기본 게이트웨이(감지한 것만, 사설 주소만).

    backend 는 컨테이너 안이라 서버의 주소를 모른다. 이 값이 비어 있으면 backend 는 서버 자신을 가리키는 대상을
    받아 주고, 출구 규칙을 거는 사이드카가 뒤늦게 거부한다(대상은 저장됐는데 세션이 열리지 않는다).
    공인 주소는 어차피 대상이 될 수 없어(허용 상한 밖) 적지 않는다.
    """
    out: list[str] = []
    for value in (facts.host_address, facts.gateway, facts.proxy_lan_ip):
        try:
            address = ipaddress.ip_address((value or "").strip())
        except ValueError:
            continue
        if address.version == 4 and any(address in net for net in _RBI_PRIVATE) and str(address) not in out:
            out.append(str(address))
    return ",".join(out)


def env_sections(answers: Answers, secrets: dict, facts: Facts, plan: Plan,
                 *, version: str, registry: str, gitea_image: str, app_version: str = "") -> list[tuple[str, list[tuple[str, str]]]]:
    s = lambda name: secrets.get(name, "")  # noqa: E731
    zones = set(plan.zones)
    d = plan.env_domain
    mail = answers.mail
    sections: list[tuple[str, list[tuple[str, str]]]] = []

    sections.append(("설치", [
        ("JW_INSTALL_ID", s("JW_INSTALL_ID")),
        ("JW_REGISTRY", registry),
        ("JW_VERSION", version),
        # 화면에 보이는 제품 버전 — 이미지에 구운 값보다 우선한다(이미지 태그와 다를 수 있다)
        ("JW_APP_VERSION", app_version or version),
        ("COMPOSE_PROJECT_NAME", "just-workspace"),
        ("DEPLOY_MODE", "standalone" if plan.tls else "external_proxy"),
        ("COMPOSE_PROFILES", ",".join(plan.profiles)),
        # 맨 앞의 core 는 "빈 값 = 전부 설치" 규칙을 피하려고 늘 적는다(최소 묶음에서도 값이 비지 않게)
        ("JW_ZONES", ",".join(["core", *plan.zones])),
        ("JW_NET_PREFIX", plan.net_prefix),
        ("JW_INSTALLER_URL", f"http://{INSTALLER_ALIAS}:{INTERNAL_API_PORT}"),
        ("JW_INSTALLER_KEY", s("JW_INSTALLER_KEY")),
        # 화면의 "소스 코드" 링크 — 설치 관리자에 준 값(-e JW_SOURCE_URL)을 그대로 넘긴다. 비어 있으면 backend 의 기본값(원래 리포)
        ("JW_SOURCE_URL", source_url_override()),
    ]))
    sections.append(("앱", [
        ("APP_NAME", "Workspace"),
        ("APP_URL", plan.app_url),
        ("DOMAIN", d),
        ("DEBUG", "false"),
        ("SECRET_KEY", s("SECRET_KEY")),
        ("INTERNAL_API_KEY", s("INTERNAL_API_KEY")),
        ("BACKEND_WORKERS", backend_workers(facts)),
        ("BACKEND_CPUS", ""),
        ("ADMIN_EMAILS", f"{answers.admin.username}@{d}" if answers.admin.username and d else ""),
    ]))
    sections.append(("저장소 · 데이터베이스", [
        ("STORAGE_VOLUME", "ws-storage-data"),
        ("STORAGE_MARKER_REQUIRED", "1"),
        ("DB_NAME", "workspace"),
        ("DB_USER", "workspace"),
        ("DB_PASSWORD", s("DB_PASSWORD")),
        ("DATABASE_URL", ""),
    ]))

    if plan.mail_builtin:
        noreply = f"noreply@{plan.mail_domain}"
        smtp = [("SMTP_HOST", "mailserver"), ("SMTP_PORT", "587"), ("SMTP_USER", noreply),
                ("SMTP_PASSWORD", s("SMTP_PASSWORD")), ("SMTP_FROM", noreply)]
    elif "mail" in zones:
        sender = mail.from_address or (mail.username if mail.username and "@" in mail.username else f"noreply@{d}")
        smtp = [("SMTP_HOST", mail.host or ""), ("SMTP_PORT", str(mail.port)), ("SMTP_USER", mail.username or ""),
                ("SMTP_PASSWORD", mail.password or ""), ("SMTP_FROM", sender)]
    else:
        smtp = [("SMTP_HOST", ""), ("SMTP_PORT", "587"), ("SMTP_USER", ""), ("SMTP_PASSWORD", ""), ("SMTP_FROM", "")]
    sections.append(("메일", [
        ("FEATURE_BUILTIN_MAILSERVER", "true" if plan.mail_builtin else "false"),
        ("DOVECOT_MASTER_USER", "portal" if plan.mail_builtin else ""),
        ("DOVECOT_MASTER_PASSWORD", s("DOVECOT_MASTER_PASSWORD") if plan.mail_builtin else ""),
        ("MAIL_SSL_TYPE", "letsencrypt"),      # 인증서를 /etc/letsencrypt/live/mail.<도메인>/ 에서 읽는다는 뜻
        *smtp,
    ]))

    git_on = "git" in zones
    sections.append(("코드 저장소", [
        ("GITEA_URL", "http://gitea:3000"),
        ("GITEA_EXTERNAL_URL", f"{plan.app_url}/git/"),
        ("GITEA_TOKEN", s("GITEA_TOKEN") if git_on else ""),
        ("GITEA_IMAGE", gitea_image if git_on else ""),
        ("GIT_SSH_PORT", "2222"),
        ("GIT_SSH_DOMAIN", plan.domain),
        ("OAUTH_CLIENTS_JSON", s("OAUTH_CLIENTS_JSON") or "{}"),
    ]))

    meetings_on = "meetings" in zones
    cert_dir = f"{CERT_ROOT}/{plan.cert_dir}"
    trusted_cert = plan.cert_mode in ("auto", "upload") and plan.tls
    sections.append(("회의", [
        ("LIVEKIT_API_KEY", s("LIVEKIT_API_KEY") if meetings_on else ""),
        ("LIVEKIT_API_SECRET", s("LIVEKIT_API_SECRET") if meetings_on else ""),
        ("LIVEKIT_URL", "http://livekit:7880"),
        ("LIVEKIT_TURN_TLS_PUBLISH", plan.turn_tls_publish),
        ("AUDIORELAY_SECRET", s("AUDIORELAY_SECRET") if plan.lossless else ""),
        ("AUDIORELAY_WT_PUBLIC_URL",
         f"https://{plan.domain}:4433/audiorelay/wt" if plan.lossless and trusted_cert else ""),
        ("AUDIORELAY_WT_PORT", "4433"),
        ("AUDIORELAY_WT_CERT", f"{cert_dir}/fullchain.pem"),
        ("AUDIORELAY_WT_KEY", f"{cert_dir}/privkey.pem"),
    ]))
    sections.append(("문서 · AI", [
        ("ONLYOFFICE_JWT_SECRET", s("ONLYOFFICE_JWT_SECRET") if "docs" in zones else ""),
        ("SEARXNG_SECRET", s("SEARXNG_SECRET") if "ai" in zones else ""),
        ("SANDBOX_TOKEN", s("SANDBOX_TOKEN") if "ai" in zones else ""),
        ("DOCCONV_TOKEN", s("DOCCONV_TOKEN") if "ai" in zones else ""),
        ("MCP_PUBLIC_URL", ""),
    ]))
    if "rbi" in zones:
        sections.append(("격리 브라우저", [
            ("RBI_PUBLIC_ORIGIN", f"https://rbi.{plan.domain}"),
            ("RBI_PUBLISH_IP", f"{plan.net_prefix}.1"),
            # 워크스페이스 자신의 주소 — 격리 브라우저의 대상으로 받지 않는다(관리자가 강제로 저장할 때만 연다)
            ("RBI_PROTECTED", rbi_protected(facts)),
        ]))
    else:
        sections.append(("격리 브라우저", [("RBI_PUBLISH_IP", f"{plan.net_prefix}.1")]))
    sections.append(("인증서 · 앞단", [
        ("LETSENCRYPT_EMAIL", answers.access.acme_email or (f"admin@{d}" if d and not v.is_ip(d) else "")),
        ("ACME_DOMAINS", ",".join(plan.cert_names)),
        ("HAIRPIN_HOST", plan.hairpin_host),
        ("RP_LAN_IP", plan.rp_lan_ip),
        ("DOMAIN_ALIAS", ""),
        ("LDAP_PLAIN_BIND", "127.0.0.1"),
    ]))
    return carry_extra_env(sections, secrets.get(EXTRA_ENV_KEY))


def carry_extra_env(sections: list[tuple[str, list[tuple[str, str]]]], extra) -> list[tuple[str, list[tuple[str, str]]]]:
    """백업에서 옮겨 온 값을 얹는다 — 이어 쓰는 변수는 제자리에서 바꾸고, 설치 관리자가 다루지 않는 변수는 끝에 덧붙인다."""
    if not isinstance(extra, dict) or not extra:
        return sections
    managed = {key for _, pairs in sections for key, _ in pairs}
    out = [(title, [(k, str(extra[k]) if k in CARRIED_ENV and extra.get(k) else val) for k, val in pairs])
           for title, pairs in sections]
    rest = sorted((k, str(val)) for k, val in extra.items() if k not in managed)
    if rest:
        out.append(("백업에서 옮겨 온 설정", rest))
    return out


# ─── nginx site.d ───

_GENERATED = "# 설치 관리자가 만든 파일입니다 — 손으로 고치지 마세요(다음 적용 때 덮어씁니다).\n"


def nginx_site(answers: Answers, plan: Plan) -> dict[str, str]:
    a = answers.access
    if not plan.tls:
        trust = "".join(f"set_real_ip_from  {v.cidr(p)};\n" for p in a.proxy_addresses)
        return {
            "nginx/site.d/http.conf": _GENERATED
            + "# 앞단 프록시 뒤 — TLS 는 프록시가 끝내고 여기는 80 평문만 듣는다.\n"
            + "# 아래 주소에서 온 연결만 X-Real-IP 를 클라이언트 주소로 믿는다.\n" + trust,
            "nginx/site.d/listen-main.conf": _GENERATED + "listen 80 default_server;\n",
            "nginx/site.d/listen-rbi.conf": _GENERATED + "listen 80;\n",
            "nginx/site.d/headers.conf": _GENERATED,
        }
    cert = f"{CERT_ROOT}/{plan.cert_dir}"
    http = _GENERATED + f"""# 이 서버가 직접 받는다 — 443 에서 TLS 를 끝내고, 80 은 인증서 확인 요청과 https 넘김만 한다.
# 신뢰 프록시가 없으므로 실제 주소 승격은 쓰지 않는다(연결 주소가 곧 클라이언트 주소).
ssl_certificate     {cert}/fullchain.pem;
ssl_certificate_key {cert}/privkey.pem;
ssl_protocols       TLSv1.2 TLSv1.3;
ssl_session_cache   shared:jw_tls:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;

server {{
    listen 80 default_server;
    server_name _;
    server_tokens off;
    access_log /var/log/nginx/access.log privacy;

    location /.well-known/acme-challenge/ {{
        root /var/www/certbot;
    }}
    location / {{
        return 301 https://$host$request_uri;
    }}
}}
"""
    # 임시(자체 서명) 인증서에는 HSTS 를 붙이지 않는다 — 브라우저가 경고를 넘기지 못하게 된다.
    hsts = "" if plan.cert_mode == "temporary" else \
        'add_header Strict-Transport-Security "max-age=31536000" always;\n'
    return {
        "nginx/site.d/http.conf": http,
        "nginx/site.d/listen-main.conf": _GENERATED + "listen 443 ssl default_server;\nhttp2 on;\n",
        "nginx/site.d/listen-rbi.conf": _GENERATED + "listen 443 ssl;\nhttp2 on;\n",
        "nginx/site.d/headers.conf": _GENERATED + hsts,
    }


def site_compose(plan: Plan, facts: Facts | None = None) -> str:
    head = _GENERATED + "# 리포의 docker-compose.yml 에 덧붙이는 사이트별 조각(-f 로 함께 넘긴다).\n"
    services = ""
    if plan.tls:
        services += '  nginx:\n    ports:\n      - "443:443"\n'
    if plan.tls and plan.cert_mode == "upload" and facts is not None and facts.site_ca:
        # 올린 인증서의 발급 CA 를 컨테이너의 신뢰 폴더에 놓는다 — 사설 CA 가 내준 인증서여도 코드 저장소가 접속 주소로
        # 되돌아가 로그인 설정 문서를 읽을 수 있고, backend 가 같은 CA 의 주소로 HTTPS 요청을 보낼 수 있다
        # (공개 CA 에 대한 신뢰는 그대로 두고 더한다).
        for service in SITE_CA_SERVICES:
            services += f"  {service}:\n    volumes:\n      - ./{SITE_CA_FILE}:{SITE_CA_MOUNT}:ro\n"
    return head + (f"services:\n{services}" if services else "services: {}\n")


# ─── LiveKit ───


def livekit_yaml(answers: Answers, secrets: dict, facts: Facts, plan: Plan) -> str:
    public_ip = answers.meetings.public_ip or facts.public_ip or ""
    if public_ip:
        public_ip = v.ipv4(public_ip)
        rtc_ip = f"  use_external_ip: false\n  node_ip: {public_ip}\n"
    else:
        rtc_ip = "  use_external_ip: true\n"       # 공인 주소를 모른다 — STUN 으로 스스로 찾게 둔다
    if plan.turn:
        td = v.domain(plan.turn_domain)
        turn = f"""turn:
  enabled: true
  domain: {td}
  tls_port: 443
  udp_port: 3478
  cert_file: {CERT_ROOT}/{td}/fullchain.pem
  key_file: {CERT_ROOT}/{td}/privkey.pem
"""
    else:
        turn = "turn:\n  enabled: false\n"
    api_key = secrets.get("LIVEKIT_API_KEY", "")
    if not api_key.isalnum():
        raise ValueError("LIVEKIT_API_KEY 는 영숫자여야 합니다")
    return _GENERATED + f"""port: 7880
bind_addresses:
  - 0.0.0.0
redis:
  address: redis:6379
  db: 0
rtc:
  port_range_start: 7882
  port_range_end: 7892
  tcp_port: 7881
{rtc_ip}{turn}room:
  enabled_codecs:
    - mime: video/vp9
    - mime: video/h264
    - mime: video/vp8
    - mime: audio/opus
    - mime: audio/red
webhook:
  api_key: {api_key}
  urls:
    - http://backend:8000/api/meetings/livekit/webhook
"""


# ─── 메일 서버 ───


def ssha512(password: str, salt_seed: str) -> str:
    """dovecot 의 `{SSHA512}` 해시. 소금은 입력에서 정해진다(같은 입력 → 같은 출력)."""
    salt = hashlib.sha256(("jw-salt:" + salt_seed).encode()).digest()[:8]
    digest = hashlib.sha512(password.encode() + salt).digest()
    return "{SSHA512}" + base64.b64encode(digest + salt).decode()


def dkim_public_value(private_pem: str) -> str:
    """DKIM TXT 레코드 값(`v=DKIM1; k=rsa; p=…`)."""
    from cryptography.hazmat.primitives import serialization

    key = serialization.load_pem_private_key(private_pem.encode(), password=None)
    der = key.public_key().public_bytes(serialization.Encoding.DER,
                                        serialization.PublicFormat.SubjectPublicKeyInfo)
    return "v=DKIM1; k=rsa; p=" + base64.b64encode(der).decode()


def mail_files(answers: Answers, secrets: dict, plan: Plan) -> dict[str, str]:
    md = v.domain(plan.mail_domain)
    seed = secrets.get("SECRET_KEY", "")
    files: dict[str, str] = {}
    accounts = [f"noreply@{md}|" + ssha512(secrets.get("SMTP_PASSWORD", ""), seed + ":noreply")]
    if answers.admin.username:
        # 관리자 편지함 자리만 만든다. 로그인은 워크스페이스 비밀번호로 한다(백엔드에 물어본다) —
        # 여기 해시는 누구도 모르는 값이라 이 줄로는 로그인할 수 없다.
        user = v.username(answers.admin.username)
        unusable = hashlib.sha256((seed + ":mailbox:" + user).encode()).hexdigest()
        accounts.append(f"{user}@{md}|" + ssha512(unusable, seed + ":" + user))
    files["mailserver/config/postfix-accounts.cf"] = "\n".join(accounts) + "\n"
    files["mailserver/config/dovecot-masters.cf"] = (
        "portal|" + ssha512(secrets.get("DOVECOT_MASTER_PASSWORD", ""), seed + ":master") + "\n")
    private_key = secrets.get("DKIM_PRIVATE_KEY", "")
    if private_key:
        files["mailserver/config/rspamd/dkim/default.private"] = private_key if private_key.endswith("\n") \
            else private_key + "\n"
        files["mailserver/config/rspamd/override.d/dkim_signing.conf"] = _GENERATED + f"""enabled = true;
sign_authenticated = true;
sign_local = true;
use_domain = "header";
use_redis = false;
use_esld = true;
check_pubkey = false;
domain {{
    {md} {{
        path = "/etc/rspamd/jw-dkim/{DKIM_SELECTOR}.private";
        selector = "{DKIM_SELECTOR}";
    }}
}}
"""
        files["mailserver/config/user-patches.d/10-dkim.sh"] = _GENERATED + f"""# 서명 키를 rspamd 만 읽을 수 있는 자리로 옮긴다(스택 폴더의 원본은 root 만 읽는다).
install -d -o _rspamd -g _rspamd -m 750 /etc/rspamd/jw-dkim
install -o _rspamd -g _rspamd -m 600 /tmp/docker-mailserver/rspamd/dkim/{DKIM_SELECTOR}.private /etc/rspamd/jw-dkim/{DKIM_SELECTOR}.private
"""
    return files


def merge_lines(existing: str, rendered: str) -> str:
    """`MERGE_FILES` — 이미 있는 줄은 그대로 두고, `|` 앞(계정)이 없는 줄만 덧붙인다."""
    have = {line.split("|", 1)[0] for line in existing.splitlines() if line.strip()}
    out = [line for line in existing.splitlines() if line.strip()]
    for line in rendered.splitlines():
        if line.strip() and line.split("|", 1)[0] not in have:
            out.append(line)
    return "\n".join(out) + "\n"


# ─── 저장소 볼륨 ───

STORAGE_VOLUME = "ws-storage-data"
NFS_OPTIONS = "rw,nfsvers=4.1,hard,noatime"      # 잠금이 프로토콜에 든 NFSv4.1 로 고정한다


def storage_volume(answers: Answers) -> dict:
    """파일 저장소 볼륨을 어떻게 만들지 — compose 는 이 이름의 볼륨을 `external` 로 쓴다.

    - 도커 볼륨: 옵션 없음
    - 지정 폴더: local 드라이버의 bind 옵션(호스트 경로)
    - NFS: local 드라이버의 nfs 옵션
    """
    s = answers.storage
    if s.kind == "nfs":
        server, export = v.hostname(s.server or ""), v.nfs_export(s.export or "")
        return {"name": STORAGE_VOLUME, "kind": "nfs",
                "opts": {"type": "nfs", "o": f"addr={server},{NFS_OPTIONS}", "device": f":{export}"}}
    if s.path:
        return {"name": STORAGE_VOLUME, "kind": "bind",
                "opts": {"type": "none", "o": "bind", "device": v.host_path(s.path)}}
    return {"name": STORAGE_VOLUME, "kind": "volume", "opts": {}}


# ─── 전체 ───


def gitea_image(answers: Answers, bundle: Bundle) -> str:
    version = answers.git.version
    if version == "verified":
        return bundle.gitea_verified_image
    if version == "latest":
        return "gitea/gitea:latest"
    return f"gitea/gitea:{v.image_tag(version)}"


def render(answers: Answers, secrets: dict, facts: Facts, bundle: Bundle,
           *, registry: str = "localhost", image_tag: str | None = None) -> dict[str, str]:
    """스택 파일 전부 — {상대 경로: 내용}."""
    catalog = Catalog(bundle.zones)
    plan = derive(answers, facts, catalog)
    files: dict[str, str] = {name: bundle.read(name) for name in STACK_COPIES}
    files[".env"] = envfile.render(env_sections(
        answers, secrets, facts, plan,
        version=image_tag or bundle.version, registry=registry, gitea_image=gitea_image(answers, bundle),
        app_version=bundle.version,
    ))
    files[SITE_COMPOSE] = site_compose(plan, facts)
    files.update(nginx_site(answers, plan))
    # compose 가 폴더째 붙이는 자리 — 비어 있어도 폴더는 있어야 한다
    files["nginx/private.d/.keep"] = ""
    files["plugins/.keep"] = ""
    if "meetings" in plan.zones:
        files["livekit/livekit.yaml"] = livekit_yaml(answers, secrets, facts, plan)
    if plan.mail_builtin:
        files.update(mail_files(answers, secrets, plan))
    return files


def summarize(files: dict[str, str]) -> list[dict]:
    """산출물 요약(경로·크기·권한) — 내용은 싣지 않는다."""
    return [{"path": p, "bytes": len(c.encode("utf-8")), "mode": oct(file_mode(p))[2:]} for p, c in sorted(files.items())]


def oauth_clients(existing_json: str, client_id: str, entry: dict | None) -> str:
    """`OAUTH_CLIENTS_JSON` 에서 클라이언트 하나를 넣거나(entry) 뺀다(None). 나머지는 그대로."""
    try:
        clients = json.loads(existing_json or "{}")
        if not isinstance(clients, dict):
            clients = {}
    except ValueError:
        clients = {}
    if entry is None:
        clients.pop(client_id, None)
    else:
        clients[client_id] = entry
    return json.dumps(clients, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
