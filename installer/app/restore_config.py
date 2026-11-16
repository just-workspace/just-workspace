"""복원의 설정 병합 — 백업의 `.env` + 새 서버에서 다시 정한 값 → 답변(Answers)과 `.env` 에 들어갈 값.

순수 함수다(파일·docker·네트워크를 건드리지 않는다). 규칙은 세 갈래다(docs/installer.md §14).

1. **백업에서 가져오는 것** — 옮겨도 바뀌면 안 되는 값
   - 비밀값 전부: 암호화 키(`SECRET_KEY` — 바뀌면 DB 안의 암호화된 값을 풀 수 없다), `INTERNAL_API_KEY`,
     DB 비밀번호(코드 저장소의 설정 파일에도 적혀 있다), 구역별 키·토큰, `GITEA_TOKEN`, `OAUTH_CLIENTS_JSON`
   - 설치 id(`JW_INSTALL_ID`) — 저장소 표식과 맞아야 한다
   - 구역 목록, 메일 종류·메일 도메인(`DOMAIN` — 계정의 메일 주소), 외부 SMTP, 코드 저장소 버전, 관리자 주소(`ADMIN_EMAILS`),
     표시 이름(`APP_NAME`), 인증서 연락처
   - 설치 관리자가 다루지 않는 그 밖의 변수(브랜드·기능 플래그·상한 등)는 그대로 옮긴다(`CARRY_NEVER` 제외)
2. **새 서버의 답변으로 덮는 것** — 서버·주소에 딸린 값
   - 접속 주소(`APP_URL`, `GITEA_EXTERNAL_URL`, `GIT_SSH_DOMAIN`, `RBI_PUBLIC_ORIGIN`, `ACME_DOMAINS` …), 연결 형태·프록시 주소·인증서,
     내부 대역, 저장소 볼륨, 워커 수, 이미지 저장소·버전, 호스트 경로
3. **새로 만드는 것** — 새 서버 고유 값
   - 설치 관리자 내부 API 키(`JW_INSTALLER_KEY`), 설치 토큰·세션·설치 관리자 인증서, 백업에 없던 비밀값
"""

from __future__ import annotations

import re

from app import answers as ans
from app import envfile
from app import validators as v
from app.bundle import Bundle
from app.catalog import Catalog
from app.render import CARRIED_ENV

# render 가 `.env` 에 쓰는 변수 가운데, 백업 값을 그대로 이어 쓰는 것(나머지 render 변수는 새 답변·감지값에서 다시 만든다)
CARRIED_KEYS = CARRIED_ENV
# render 가 쓰지 않는 변수 가운데 옮기지 않는 것 — 원래 서버의 호스트·망·주소에 딸린 값, 한 번 쓰고 버리는 값
CARRY_NEVER = frozenset({
    "GPU_HOST_IP", "JW_HOST_REPO", "BACKUP_VOLUME", "GITEA_DATA_PATH", "RBI_NETWORK", "RBI_SUBNET", "RBI_IP_RANGE",
    "RBI_BRIDGE", "RBI_MIRROR_IMAGE", "RBI_IMAGE", "AUDIORELAY_WT_SELF_SIGNED_HOSTS", "ADMIN_USERNAME", "ADMIN_PASSWORD",
    "JW_MIGRATE_ON_START", "JW_PROJECT_DIR", "JW_CONTAINER_PREFIX", "MCP_PUBLIC_URL", "DOMAIN_ALIAS", "DATABASE_URL",
})
# 새 서버에서 새로 만드는 것 — 백업 값이 있어도 쓰지 않는다
REGENERATED = frozenset({"JW_INSTALLER_KEY", "JW_INSTALLER_URL"})
# 비밀값 표(backend 의 security_defaults) 밖에서 `.env` 비밀로 다루는 이름
EXTRA_SECRET_NAMES = ("SMTP_PASSWORD", "GITEA_TOKEN", "OAUTH_CLIENTS_JSON", "JW_INSTALL_ID")

_GITEA_TAG = re.compile(r"gitea/gitea:([A-Za-z0-9._-]+)")


def parse_env(text: str) -> dict[str, str]:
    """백업의 `.env` → {키: 값}. 설치 관리자가 쓴 파일과 손으로 쓴 파일(따옴표 없는 값 뒤의 주석)을 모두 읽는다."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        key, _, raw = stripped.partition("=")
        key, raw = key.strip(), raw.strip()
        if not envfile._KEY.fullmatch(key):
            continue
        if raw[:1] in ("'", '"'):
            end = raw.rfind(raw[0])
            raw = raw[:end + 1] if end > 0 else raw
        else:
            raw = re.split(r"\s+#", raw, maxsplit=1)[0]
        values[key] = envfile.unquote(raw)
    return values


def secret_names(bundle: Bundle) -> list[str]:
    return [*bundle.security_defaults.names(), *EXTRA_SECRET_NAMES]


def carried_secrets(env: dict[str, str], bundle: Bundle) -> dict[str, str]:
    """백업에서 가져오는 비밀값(빈 값은 뺀다 — 새 서버에서 만든다)."""
    return {name: env[name] for name in secret_names(bundle)
            if env.get(name) and name not in REGENERATED and "\n" not in env[name]}


def backup_host(env: dict[str, str], summary: dict) -> str:
    """백업을 만든 서버의 접속 주소(호스트) — `APP_URL` 에서. 메일 도메인(`DOMAIN`)과 다를 수 있다."""
    url = env.get("APP_URL") or summary.get("source_url") or ""
    host = re.sub(r"^[a-z]+://", "", url.strip(), flags=re.I).split("/", 1)[0]
    if host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host or (summary.get("domain") or env.get("DOMAIN") or "")


def backup_zones(env: dict[str, str], summary: dict, catalog: Catalog) -> tuple[list[str], list[str], list[str]]:
    """(구역, 부가 구역, 이 설치 관리자가 모르는 구역) — manifest 의 구역 목록, 없으면 `.env` 의 `JW_ZONES`."""
    listed = summary.get("zones")
    if not isinstance(listed, list) or not listed:
        listed = [z.strip() for z in (env.get("JW_ZONES") or "").split(",") if z.strip()]
    listed = [z for z in listed if z != "core"]
    zones = [z for z in catalog.zone_ids if z in listed]
    addons = [z for z in catalog.addon_ids if z in listed]
    unknown = [z for z in listed if not catalog.known(z)]
    return zones, addons, unknown


def git_version(image: str, bundle: Bundle) -> str:
    """백업의 `GITEA_IMAGE` → 답변의 `git.version`. 모르는 꼴이면 검증한 버전으로 간다(데이터는 위로만 옮겨진다)."""
    image = (image or "").strip()
    if not image or image == bundle.gitea_verified_image:
        return "verified"
    m = _GITEA_TAG.fullmatch(image)
    if m:
        return "latest" if m.group(1) == "latest" else m.group(1)
    return "verified"


def subnet_of(env: dict[str, str]) -> str:
    prefix = (env.get("JW_NET_PREFIX") or "").strip()
    try:
        return v.subnet24(f"{prefix}.0/24") if prefix else ans.DEFAULT_SUBNET
    except v.Invalid:
        return ans.DEFAULT_SUBNET


def network_of(env: dict[str, str]) -> str | None:
    """백업의 연결 형태 — 앞단 프록시 뒤였는지만 알 수 있다(직접·공유기는 `.env` 로 가릴 수 없다)."""
    mode = (env.get("DEPLOY_MODE") or "").strip()
    if mode == "external_proxy":
        return "proxy"
    return "direct" if mode == "standalone" else None


def answers_from_backup(env: dict[str, str], summary: dict, target: dict, catalog: Catalog, bundle: Bundle,
                        *, turn: bool | None = None) -> tuple[ans.Answers, dict[str, str]]:
    """백업 설정 + 새 서버에서 정한 값(`target`) → (답변, 답변의 비밀).

    target: {"domain", "network", "proxy_addresses", "cert", "storage": {kind, path, server, export}, "subnet",
             "restore": {path, password_file}} — 빠진 값은 백업에서(주소·대역) 또는 기본값으로 채운다.
    구역·메일·회의·코드 저장소·관리자는 묻지 않는다 — 백업에서 온다.
    """
    zones, addons, _unknown = backup_zones(env, summary, catalog)
    domain = (target.get("domain") or backup_host(env, summary) or "").strip()
    network = target.get("network") or network_of(env) or "direct"
    cert = target.get("cert") or ("proxy" if network == "proxy" else "auto")

    builtin = (env.get("FEATURE_BUILTIN_MAILSERVER") or "").strip().lower() == "true"
    mail: dict = {"kind": "builtin", "mail_domain": env.get("DOMAIN") or domain}
    secrets: dict[str, str] = {}
    if "mail" in zones and not builtin:
        port = (env.get("SMTP_PORT") or "587").strip()
        mail = {"kind": "external", "host": env.get("SMTP_HOST") or None, "port": int(port) if port.isdigit() else 587,
                "username": env.get("SMTP_USER") or None, "from_address": env.get("SMTP_FROM") or None}
        if env.get("SMTP_PASSWORD"):
            secrets["mail.password"] = env["SMTP_PASSWORD"]

    profiles = {p.strip() for p in (env.get("COMPOSE_PROFILES") or "").split(",") if p.strip()}
    meetings = {
        # 중계(TURN)는 백업의 회의 서버 설정에서 읽은 값(`turn`). 모르면 켠다 — 주소가 IP 면 렌더링이 끈다
        "turn": (True if turn is None else bool(turn)) and not (bool(domain) and v.is_ip(domain)),
        "lossless_audio": "audiorelay" in profiles and "chat" in zones,
        "public_ip": None,                       # 새 서버의 공인 주소(감지값)를 쓴다
    }
    admin_user = ""
    first = (env.get("ADMIN_EMAILS") or "").split(",")[0].strip()
    if "@" in first:
        try:
            admin_user = v.username(first.split("@", 1)[0])
        except v.Invalid:
            admin_user = ""

    storage = dict(target.get("storage") or {"kind": "local"})
    data = {
        "mode": "restore",
        "access": {"domain": domain, "network": network, "proxy_addresses": list(target.get("proxy_addresses") or []),
                   "cert": cert, "acme_email": (env.get("LETSENCRYPT_EMAIL") or "").strip() or None,
                   "cert_path": target.get("cert_path"), "key_path": target.get("key_path"),
                   "ca_path": target.get("ca_path")},
        "storage": {k: storage.get(k) for k in ("kind", "path", "server", "export") if storage.get(k)},
        "preset": None,
        "zones": zones,
        "addons": addons,
        "mail": mail,
        "meetings": meetings,
        "ai": {"mode": "later"},                 # AI 제공자 설정은 DB 에 있다(백업과 함께 온다)
        "git": {"version": git_version(env.get("GITEA_IMAGE", ""), bundle)},
        "advanced": {"subnet": target.get("subnet") or subnet_of(env)},
        "admin": {"name": admin_user, "username": admin_user},
        "restore": dict(target.get("restore") or {}),
    }
    try:
        v.email(data["access"]["acme_email"] or "")
    except v.Invalid:
        data["access"]["acme_email"] = None
    return ans.load(data), secrets


def extra_env(env: dict[str, str], managed: set[str], bundle: Bundle) -> dict[str, str]:
    """`.env` 에 그대로 옮길 값 — 이어 쓰는 값(`CARRIED_KEYS`)과 설치 관리자가 다루지 않는 변수.

    managed = render 가 스스로 쓰는 변수 이름. 그 변수들은 새 답변에서 다시 만들므로 옮기지 않는다.
    줄바꿈이 든 값과 빈 값은 옮기지 않는다.
    """
    secret = set(secret_names(bundle))
    out: dict[str, str] = {}
    for key, value in env.items():
        if not value or "\n" in value or "\r" in value or "\x00" in value:
            continue
        if key in CARRIED_KEYS:
            out[key] = value
        elif key in managed or key in secret or key in CARRY_NEVER or key in REGENERATED:
            continue
        else:
            out[key] = value
    return out


def version_tuple(text: str) -> tuple[int, ...]:
    """`1.4.0-beta.2` → (1, 4, 0). 숫자가 아닌 뒤쪽은 버린다."""
    parts = []
    for piece in re.split(r"[.\-+]", (text or "").strip().lstrip("vV")):
        if not piece.isdigit():
            break
        parts.append(int(piece))
    return tuple(parts)


def judge_version(summary: dict, *, installer_version: str, installer_schema: int | None) -> dict:
    """복원할 수 있는 버전인가 — 백업의 스키마·제품 버전이 이 설치 관리자의 것보다 높으면 막는다.

    낮거나 같으면 진행한다(복원 뒤 스키마 변경 단계가 차이를 메운다).
    {"status": ok|newer, "reason": null|schema|product}
    """
    schema = summary.get("schema_version")
    if isinstance(schema, int) and isinstance(installer_schema, int) and schema > installer_schema:
        return {"status": "newer", "reason": "schema"}
    theirs, ours = version_tuple(str(summary.get("product_version") or "")), version_tuple(installer_version)
    if theirs and ours and theirs > ours:
        return {"status": "newer", "reason": "product"}
    return {"status": "ok", "reason": None}


def turn_enabled(livekit_yaml: str | None) -> bool | None:
    """백업의 회의 서버 설정에서 중계(TURN)가 켜져 있었는지. 파일이 없으면 None."""
    if not livekit_yaml:
        return None
    m = re.search(r"^turn:\s*\n(?:[ \t]+.*\n)*?[ \t]+enabled:\s*(true|false)", livekit_yaml + "\n", flags=re.M)
    return (m.group(1) == "true") if m else None
