"""렌더링 — 응답 + 비밀값 + 감지값 → 스택 파일 내용.

순수 함수이다(파일·네트워크·시계·난수에 접근하지 않는다). 동일 입력이면 동일 출력을 반환한다.

    plan  = derive(answers, facts, catalog)            # 파생값(구역·프로파일·포트·이름·주의)
    files = render(answers, secrets, facts, bundle)     # {스택 안 상대 경로: 내용}

`secrets` 는 `.env` 에 포함되는 비밀값과 설치 관리자가 관리하는 값이다.
- backend 의 비밀값 표에 있는 이름(SECRET_KEY, DB_PASSWORD …)
- `SMTP_PASSWORD`(내장 메일의 발신 계정), `JW_INSTALLER_KEY`(내부 API 키), `JW_INSTALL_ID`
- `DKIM_PRIVATE_KEY`(PEM — 메일 레코드 확인 화면에서 사전 생성한 것)
- 구역 훅이 설정하는 값(`GITEA_TOKEN`, `OAUTH_CLIENTS_JSON`)

경로는 모두 **스택 폴더 기준 상대 경로**이다(컨테이너 내 `/data/stack/…`, 호스트 `$JW_HOST_DIR/stack/…`).
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
from app.update_release import source_url_override, valid_source_url

HAIRPIN_OFF = "hairpin-off.invalid"
TURN_TLS_PORT_STANDALONE = 5349      # nginx 가 443 을 사용하는 서버에서 TURN/TLS 를 게시하는 호스트 포트
INTERNAL_API_PORT = 8444             # 설치 관리자 내부 API(워크스페이스 내부망 전용)
INSTALLER_ALIAS = "jw-installer"
DKIM_SELECTOR = "default"
# 복원한 설치에서 백업의 `.env` 로부터 그대로 이전한 값을 보관하는 위치(`env.secret.json` 내 사전 1개).
# 설치 관리자가 자체적으로 기록하는 변수 중에서는 `CARRIED_ENV` 만 이 값으로 교체하고, 관리 대상이 아닌 변수는 끝에 추가한다.
EXTRA_ENV_KEY = "_extra_env"
CARRIED_ENV = ("APP_NAME", "DOMAIN", "ADMIN_EMAILS")
CERT_ROOT = "/etc/letsencrypt/live"
SITE_CA_FILE = "site-ca/ca.pem"                         # 스택 폴더 기준 — 업로드한 인증서의 발급 CA(동반된 체인 + 별도 업로드한 CA, 적용 엔진이 기록)
SITE_CA_MOUNT = "/etc/ssl/certs/jw-site-ca.pem"         # 컨테이너 내 — 코드 저장소는 시스템 CA 폴더의 파일로 읽고, backend 는 기동 시 CA 번들에 추가
SITE_CA_SERVICES = ("gitea", "backend")                 # 접속 주소(및 동일 CA 의 주소)로 HTTPS 요청을 송신하는 본 프로젝트 컨테이너

# 권한이 600 이어야 하는 파일 / 실행 권한이 필요한 파일
SECRET_FILES = (".env", "mailserver/config/dovecot-masters.cf", "mailserver/config/postfix-accounts.cf",
                "mailserver/config/rspamd/dkim/default.private")
# 이미 존재하면 줄 단위로 병합하는 파일(메일 계정은 운영 중 백엔드가 추가)
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
    tls: bool                   # 내장 nginx 가 TLS 를 종단
    cert_mode: str
    cert_dir: str               # nginx 가 읽는 인증서 폴더 이름(= 접속 주소)
    cert_names: list[str]       # 인증서에 포함되어야 하는 이름(첫 번째가 폴더 이름)
    cert_aliases: list[str]     # 동일 인증서를 가리키도록 할 폴더 이름(서비스마다 조회 위치가 상이)
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

    # ── 호스트에 게시하는 포트 ──
    ports = catalog.ports(zones)

    def drop(*names: str) -> None:
        for name in names:
            if name in ports:
                ports.remove(name)

    if proxy:
        drop("443/tcp")
    # 평문 LDAP(389)은 이 서버 자신(루프백)에만 게시한다(LDAP_PLAIN_BIND=127.0.0.1) — 외부 게시 포트가 아니다
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

    # ── 컨테이너가 접속 주소로 회귀 접속할 때의 우회 ──
    if is_ip or not domain:
        hairpin_host, rp_lan_ip = HAIRPIN_OFF, ""
    elif tls:
        hairpin_host, rp_lan_ip = domain, f"{net_prefix}.2"        # 내장 nginx 가 443 을 수신
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

    # ── 주의 사항 목록 ──
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
    if meetings_on and facts.cpus and facts.cpus < RECORDING_CPUS:
        cautions.append({"key": "meetings_recording_low_cpu", "vars": {"cpus": facts.cpus, "recommend": RECORDING_CPUS}})
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
    """워커 수 — backend entrypoint 와 동일 규칙(min 8, max 2, 코어 수). 메모리가 6GB 미만이면 2."""
    if not facts.cpus:
        return ""
    workers = min(8, max(2, int(facts.cpus)))
    if facts.memory_mb and facts.memory_mb < 6 * 1024:
        workers = 2
    return str(workers)


RECORDING_CPUS = 4      # 회의 녹화(egress)의 권장 코어 수 = 룸 합성 녹화 1건의 CPU 요구량 기본값


def egress_limits(facts: Facts) -> tuple[str, str]:
    """(`EGRESS_CPUS`, `EGRESS_ROOM_CPU_COST`) — 녹화 컨테이너의 CPU 상한과 룸 합성 녹화 1건의 요구량.

    compose 의 CPU 상한이 서버의 코어 수를 초과하면 도커가 컨테이너 생성을 거부한다. 코어가 권장 수(4) 미만이면 상한을
    코어 수로, 요구량을 (코어 수 - 1, 최소 1)로 낮춘다 — 요구량이 가용 CPU 를 초과하면 녹화 요청이 전부 거절되기 때문이다.
    코어 수 미확인 시 빈 값(compose 의 기본값 4 적용).
    """
    if not facts.cpus:
        return "", ""
    cpus = int(facts.cpus)
    if cpus >= RECORDING_CPUS:
        return str(RECORDING_CPUS), str(RECORDING_CPUS)
    return str(cpus), str(max(1, cpus - 1))


# 격리 브라우저의 대상이 될 수 있는 대역(backend 의 RBI_ALLOW_CEILING 기본값과 동일)
_RBI_PRIVATE = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def rbi_protected(facts: Facts) -> str:
    """`RBI_PROTECTED` — 이 서버의 주소와 기본 게이트웨이(감지된 것만, 사설 주소만).

    backend 는 컨테이너 내에 있어 서버의 주소를 알 수 없다. 이 값이 비어 있으면 backend 는 서버 자신을 가리키는 대상을
    허용하고, 출구 규칙을 적용하는 사이드카가 사후에 거부한다(대상은 저장되었으나 세션이 열리지 않는다).
    공인 주소는 대상이 될 수 없으므로(허용 상한 밖) 기재하지 않는다.
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
        # 화면에 표시되는 제품 버전 — 이미지에 내장된 값보다 우선한다(이미지 태그와 상이할 수 있음)
        ("JW_APP_VERSION", app_version or version),
        ("COMPOSE_PROJECT_NAME", "just-workspace"),
        ("DEPLOY_MODE", "standalone" if plan.tls else "external_proxy"),
        ("COMPOSE_PROFILES", ",".join(plan.profiles)),
        # 맨 앞의 core 는 "빈 값 = 전부 설치" 규칙을 회피하기 위해 항상 기재한다(최소 프리셋에서도 값이 비지 않도록 함)
        ("JW_ZONES", ",".join(["core", *plan.zones])),
        ("JW_NET_PREFIX", plan.net_prefix),
        ("JW_INSTALLER_URL", f"http://{INSTALLER_ALIAS}:{INTERNAL_API_PORT}"),
        ("JW_INSTALLER_KEY", s("JW_INSTALLER_KEY")),
    ]))
    # 화면의 "소스 코드" 링크 — 설치 관리자에 지정한 값(-e JW_SOURCE_URL), 없으면 보존된 값(settle_source_url).
    # 값이 없으면 해당 줄을 포함하지 않는다 — backend 는 변수가 없는 경우와 비어 있는 경우 모두 원래 리포의 주소를 사용한다.
    source = source_url_override() or valid_source_url(facts.source_url)
    if source:
        sections[-1][1].append(("JW_SOURCE_URL", source))
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
        ("MAIL_SSL_TYPE", "letsencrypt"),      # 인증서를 /etc/letsencrypt/live/mail.<도메인>/ 에서 읽음을 의미
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
        ("EGRESS_CPUS", egress_limits(facts)[0] if meetings_on else ""),
        ("EGRESS_ROOM_CPU_COST", egress_limits(facts)[1] if meetings_on else ""),
    ]))
    sections.append(("문서 · AI", [
        ("ONLYOFFICE_JWT_SECRET", s("ONLYOFFICE_JWT_SECRET") if "docs" in zones else ""),
        # 문서 편집기가 접속 주소로 회귀 접속할 때의 인증서 검증 생략 — 브라우저가 신뢰하지 않는 인증서(임시, 사설 CA)를
        # 내장 nginx 가 제공하는 구성에 한한다(회귀 접속은 내부망의 nginx 로 고정되어 있다 — HAIRPIN_HOST·RP_LAN_IP)
        ("ONLYOFFICE_ALLOW_UNTRUSTED_CERT", "true" if "docs" in zones and plan.tls and (
            plan.cert_mode == "temporary" or (plan.cert_mode == "upload" and facts.site_ca)) else "false"),
        ("SEARXNG_SECRET", s("SEARXNG_SECRET") if "ai" in zones else ""),
        ("SANDBOX_TOKEN", s("SANDBOX_TOKEN") if "ai" in zones else ""),
        ("DOCCONV_TOKEN", s("DOCCONV_TOKEN") if "ai" in zones else ""),
        ("MCP_PUBLIC_URL", ""),
    ]))
    if "rbi" in zones:
        sections.append(("격리 브라우저", [
            ("RBI_PUBLIC_ORIGIN", f"https://rbi.{plan.domain}"),
            ("RBI_PUBLISH_IP", f"{plan.net_prefix}.1"),
            # 워크스페이스 자체 주소 — 격리 브라우저의 대상으로 허용하지 않는다(관리자가 강제 저장하는 경우만 허용)
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


def settle_source_url(store, facts: Facts, stack_dir) -> None:
    """소스 주소(`JW_SOURCE_URL`)를 감지값에 보존한다 — 스택 파일 기록 직전에 호출한다.

    스택 파일은 설치 관리자 컨테이너 외에서도 기록한다: 업데이트의 `switch` 단계는 새 버전 이미지의 일회용 컨테이너가 기록하고
    (해당 컨테이너에는 사용자가 지정한 환경변수가 없다), 복원은 새 서버의 설치 관리자가 기록한다. 각 경우에 값이 소실되지 않도록
    한 번 확정된 주소는 상태 폴더에 보존한다. 우선순위: 현재 전달된 환경변수 → 보존된 값 → 현재 `.env` 에 기록된 값
    (이 보존 기능이 없던 버전에서 업그레이드한 설치). 기본값(원래 리포)으로 복원하려면 해당 주소를 직접 지정한다.
    """
    current = ""
    try:
        for line in (stack_dir / ".env").read_text(encoding="utf-8").splitlines():
            if line.startswith("JW_SOURCE_URL="):
                current = envfile.unquote(line.split("=", 1)[1].strip())
    except OSError:
        pass
    want = source_url_override() or valid_source_url(facts.source_url) or valid_source_url(current)
    if want != (facts.source_url or ""):
        facts.source_url = want or None
        store.update_facts(source_url=facts.source_url)


def carry_extra_env(sections: list[tuple[str, list[tuple[str, str]]]], extra) -> list[tuple[str, list[tuple[str, str]]]]:
    """백업에서 이전한 값을 적용한다 — 승계 변수는 제자리에서 교체하고, 설치 관리자의 관리 대상이 아닌 변수는 끝에 추가한다."""
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
    # 임시(자체 서명) 인증서에는 HSTS 를 적용하지 않는다 — 브라우저에서 경고 우회가 불가능해진다.
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
        # 업로드한 인증서의 발급 CA 를 컨테이너의 신뢰 저장소에 배치한다 — 사설 CA 발급 인증서여도 코드 저장소가 접속 주소로
        # 회귀 접속하여 로그인 설정 문서를 읽을 수 있고, backend 가 동일 CA 의 주소로 HTTPS 요청을 송신할 수 있다
        # (공개 CA 에 대한 신뢰는 유지한 채 추가한다).
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
        rtc_ip = "  use_external_ip: true\n"       # 공인 주소 미확인 — STUN 으로 자체 탐지하도록 설정
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
    """dovecot 의 `{SSHA512}` 해시. 솔트는 입력에서 결정된다(동일 입력 → 동일 출력)."""
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
        # 관리자 편지함 위치만 생성한다. 로그인은 워크스페이스 비밀번호로 수행한다(백엔드에 조회) —
        # 이 해시는 누구도 알 수 없는 값이므로 이 줄로는 로그인할 수 없다.
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
    """`MERGE_FILES` — 기존 줄은 유지하고, `|` 앞(계정)이 없는 줄만 추가한다."""
    have = {line.split("|", 1)[0] for line in existing.splitlines() if line.strip()}
    out = [line for line in existing.splitlines() if line.strip()]
    for line in rendered.splitlines():
        if line.strip() and line.split("|", 1)[0] not in have:
            out.append(line)
    return "\n".join(out) + "\n"


# ─── 저장소 볼륨 ───

STORAGE_VOLUME = "ws-storage-data"
NFS_OPTIONS = "rw,nfsvers=4.1,hard,noatime"      # 잠금이 프로토콜에 포함된 NFSv4.1 로 고정


def storage_volume(answers: Answers) -> dict:
    """파일 저장소 볼륨의 생성 방식 — compose 는 이 이름의 볼륨을 `external` 로 사용한다.

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
    # compose 가 폴더 단위로 마운트하는 위치 — 비어 있어도 폴더는 존재해야 한다
    files["nginx/private.d/.keep"] = ""
    files["plugins/.keep"] = ""
    if "meetings" in plan.zones:
        files["livekit/livekit.yaml"] = livekit_yaml(answers, secrets, facts, plan)
    if plan.mail_builtin:
        files.update(mail_files(answers, secrets, plan))
    return files


def summarize(files: dict[str, str]) -> list[dict]:
    """산출물 요약(경로·크기·권한) — 내용은 포함하지 않는다."""
    return [{"path": p, "bytes": len(c.encode("utf-8")), "mode": oct(file_mode(p))[2:]} for p, c in sorted(files.items())]


def oauth_clients(existing_json: str, client_id: str, entry: dict | None) -> str:
    """`OAUTH_CLIENTS_JSON` 에서 클라이언트 하나를 추가하거나(entry) 제거한다(None). 나머지는 유지."""
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
