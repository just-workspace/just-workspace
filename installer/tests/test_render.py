"""렌더링 — 스냅샷(다섯 구성)과 구성별 성질.

스냅샷은 tests/snapshots/<구성>/ 에 있다. 의도한 변경이면 `JW_UPDATE_SNAPSHOTS=1 pytest` 로 다시 만든다.
번들에서 그대로 복사하는 파일(compose·nginx.conf 등)은 스냅샷에 넣지 않는다(리포 원본이 단일 출처).
"""

import json
import os
from pathlib import Path

import pytest

from app import answers as ans
from app import envfile, render
from app.bundle import STACK_COPIES
from tests.conftest import make_answers

SNAP = Path(__file__).parent / "snapshots"

CASES = {
    "direct-auto": dict(),
    "proxy": dict(access={"network": "proxy", "cert": "proxy", "proxy_addresses": ["192.168.10.5"]},
                  zones=["mail", "chat", "calendar", "docs", "git"], preset=None),
    "nfs": dict(storage={"kind": "nfs", "server": "192.168.10.9", "export": "/export/workspace"}),
    "minimal": dict(preset="minimal", mail={}),
    "full": dict(preset="full", addons=["sso", "rbi"],
                 meetings={"public_ip": "203.0.113.10", "turn": True, "lossless_audio": True},
                 git={"version": "verified"}),
}


def build(case: str, bundle, secrets, facts) -> dict[str, str]:
    a = make_answers(**CASES[case])
    if "mail" in ans.selected_zones(a, render.Catalog(bundle.zones)) and a.mail.kind == "builtin":
        secrets = {**secrets, "DKIM_PRIVATE_KEY": DKIM_KEY}
    files = render.render(a, secrets, facts, bundle, registry="registry.example.com/jw", image_tag="1.0.0")
    generated = {p: c for p, c in files.items() if p not in STACK_COPIES}
    plan = render.derive(a, facts, render.Catalog(bundle.zones))
    generated["_plan.json"] = json.dumps(plan.as_dict(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    generated["_storage.json"] = json.dumps(render.storage_volume(a), indent=2, sort_keys=True) + "\n"
    return generated


# 렌더링은 키 내용을 그대로 옮겨 적을 뿐이다 — 스냅샷에는 진짜 키 대신 자리표시자를 쓴다
DKIM_KEY = "(test placeholder - not a key)\n"


@pytest.mark.parametrize("case", sorted(CASES))
def test_snapshot(case, bundle, secrets, facts):
    got = build(case, bundle, secrets, facts)
    folder = SNAP / case
    if os.environ.get("JW_UPDATE_SNAPSHOTS") == "1":
        if folder.exists():
            for old in sorted(folder.rglob("*"), reverse=True):
                old.unlink() if old.is_file() else old.rmdir()
        for path, content in got.items():
            target = folder / path.replace("/", "__")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8", newline="")
    expected = {p.name.replace("__", "/"): p.read_text(encoding="utf-8") for p in folder.iterdir()}
    assert sorted(got) == sorted(expected)
    for path in sorted(got):
        assert got[path] == expected[path], f"{case}: {path} 가 스냅샷과 다릅니다"


def env_of(files) -> dict[str, str]:
    return envfile.parse(files[".env"])


def test_direct_auto_properties(bundle, secrets, facts):
    files = render.render(make_answers(), secrets, facts, bundle)
    env = env_of(files)
    assert env["JW_ZONES"] == "core,mail,chat,calendar,docs"
    assert env["COMPOSE_PROFILES"] == "mailserver,onlyoffice,certbot"
    assert env["DEPLOY_MODE"] == "standalone" and env["APP_URL"] == "https://ws.example.com"
    assert env["DOMAIN"] == "example.com"                      # 계정 메일 주소의 도메인
    assert env["FEATURE_BUILTIN_MAILSERVER"] == "true"
    assert env["ACME_DOMAINS"] == "ws.example.com,mail.example.com"
    assert env["RP_LAN_IP"] == "172.28.0.2" and env["HAIRPIN_HOST"] == "ws.example.com"
    assert env["STORAGE_MARKER_REQUIRED"] == "1"
    assert env["LIVEKIT_API_SECRET"] == "" and env["SANDBOX_TOKEN"] == ""     # 꺼진 구역의 비밀값은 싣지 않는다
    http = files["nginx/site.d/http.conf"]
    assert "ssl_certificate     /etc/letsencrypt/live/ws.example.com/fullchain.pem;" in http
    assert "return 301 https://$host$request_uri;" in http and "set_real_ip_from" not in http
    assert "listen 443 ssl default_server;" in files["nginx/site.d/listen-main.conf"]
    assert "Strict-Transport-Security" in files["nginx/site.d/headers.conf"]
    assert '"443:443"' in files[render.SITE_COMPOSE]
    assert "livekit/livekit.yaml" not in files
    # 번들 파일은 내용 그대로
    assert files["docker-compose.yml"] == bundle.read("docker-compose.yml")
    assert files["nginx/nginx.conf"] == bundle.read("nginx/nginx.conf")


def test_proxy_properties(bundle, secrets, facts):
    a = make_answers(**CASES["proxy"])
    files = render.render(a, secrets, facts, bundle)
    env = env_of(files)
    assert env["DEPLOY_MODE"] == "external_proxy"
    assert "certbot" not in env["COMPOSE_PROFILES"].split(",")
    assert env["RP_LAN_IP"] == "192.168.10.5" and env["HAIRPIN_HOST"] == "ws.example.com"
    http = files["nginx/site.d/http.conf"]
    assert "set_real_ip_from  192.168.10.5;" in http and "ssl_certificate" not in http and "server {" not in http
    assert files["nginx/site.d/listen-main.conf"].endswith("listen 80 default_server;\n")
    assert "Strict-Transport-Security" not in files["nginx/site.d/headers.conf"]
    assert "443" not in files[render.SITE_COMPOSE]
    plan = render.derive(a, facts, render.Catalog(bundle.zones))
    assert "443/tcp" not in plan.ports and "80/tcp" in plan.ports and "2222/tcp" in plan.ports


def test_proxy_with_several_addresses_turns_hairpin_off(bundle, secrets, facts):
    a = make_answers(access={"network": "proxy", "cert": "proxy", "proxy_addresses": ["10.0.0.0/24", "10.0.1.4"]},
                     zones=["git"], preset=None)
    env = env_of(render.render(a, secrets, facts, bundle))
    assert env["HAIRPIN_HOST"] == render.HAIRPIN_OFF and env["RP_LAN_IP"] == ""
    plan = render.derive(a, facts, render.Catalog(bundle.zones))
    assert "hairpin_not_configured" in {c["key"] for c in plan.cautions}


def test_minimal_properties(bundle, secrets, facts):
    files = render.render(make_answers(**CASES["minimal"]), secrets, facts, bundle)
    env = env_of(files)
    assert env["JW_ZONES"] == "core"            # 비우면 "전부 설치"로 읽히므로 core 를 적는다
    assert env["COMPOSE_PROFILES"] == "certbot"
    assert env["FEATURE_BUILTIN_MAILSERVER"] == "false" and env["SMTP_HOST"] == ""
    assert env["DOMAIN"] == "ws.example.com"
    assert not any(p.startswith("mailserver/config/postfix") for p in files)


def test_full_properties(bundle, secrets, facts):
    a = make_answers(**CASES["full"])
    files = render.render(a, {**secrets, "DKIM_PRIVATE_KEY": DKIM_KEY}, facts, bundle)
    env = env_of(files)
    assert env["JW_ZONES"] == "core,mail,chat,calendar,docs,meetings,git,ai,sso,rbi"
    assert env["COMPOSE_PROFILES"].split(",") == [
        "mailserver", "onlyoffice", "livekit", "egress", "audiorelay", "gitea", "aitools", "sso", "rbi", "certbot"]
    assert env["LIVEKIT_TURN_TLS_PUBLISH"] == "5349"
    assert env["ACME_DOMAINS"] == "ws.example.com,mail.example.com,turn.ws.example.com,rbi.ws.example.com"
    assert env["GITEA_IMAGE"] == bundle.gitea_verified_image
    assert env["RBI_PUBLIC_ORIGIN"] == "https://rbi.ws.example.com"
    assert env["RBI_PROTECTED"] == ""          # 서버 주소를 감지하지 못했으면 비운다(지어내지 않는다)
    lk = files["livekit/livekit.yaml"]
    assert "node_ip: 203.0.113.10" in lk and "domain: turn.ws.example.com" in lk
    assert f"api_key: {secrets['LIVEKIT_API_KEY']}" in lk
    assert "example.com {" in files["mailserver/config/rspamd/override.d/dkim_signing.conf"]
    plan = render.derive(a, facts, render.Catalog(bundle.zones))
    assert plan.cert_aliases == ["mail.example.com", "turn.ws.example.com"]
    assert {"5349/tcp", "3478/udp", "4433/udp", "25/tcp", "2222/tcp", "636/tcp"} <= set(plan.ports)
    assert "389/tcp" not in plan.ports                 # 평문 LDAP 은 루프백에만 연다 — 여는 포트로 안내하지 않는다


def test_meetings_without_turn_or_lossless(bundle, secrets, facts):
    a = make_answers(preset=None, zones=["chat", "meetings"], meetings={"turn": False, "lossless_audio": False})
    files = render.render(a, secrets, ans.Facts(memory_mb=16000), bundle)
    env = env_of(files)
    assert "audiorelay" not in env["COMPOSE_PROFILES"].split(",") and env["AUDIORELAY_SECRET"] == ""
    assert "enabled: false" in files["livekit/livekit.yaml"] and "use_external_ip: true" in files["livekit/livekit.yaml"]
    plan = render.derive(a, ans.Facts(), render.Catalog(bundle.zones))
    assert "3478/udp" not in plan.ports and "4433/udp" not in plan.ports
    assert "meetings_public_ip_unknown" in {c["key"] for c in plan.cautions}


def test_external_mail(bundle, secrets, facts):
    a = make_answers(preset=None, zones=["mail"],
                     mail={"kind": "external", "host": "smtp.example.net", "port": 465, "security": "ssl",
                           "username": "sender@example.net", "password": "p'w $HOME #x"})
    files = render.render(a, secrets, facts, bundle)
    env = env_of(files)
    assert env["SMTP_HOST"] == "smtp.example.net" and env["SMTP_PORT"] == "465"
    assert env["SMTP_PASSWORD"] == "p'w $HOME #x" and env["SMTP_FROM"] == "sender@example.net"
    assert "mailserver" not in env["COMPOSE_PROFILES"].split(",")
    assert env["FEATURE_BUILTIN_MAILSERVER"] == "false" and env["DOMAIN"] == "ws.example.com"
    plan = render.derive(a, facts, render.Catalog(bundle.zones))
    assert "25/tcp" not in plan.ports


def test_temporary_cert_has_no_hsts(bundle, secrets):
    a = make_answers(access={"cert": "temporary"})
    files = render.render(a, secrets, ans.Facts(dns_status="mismatch"), bundle)
    assert "Strict-Transport-Security" not in files["nginx/site.d/headers.conf"]
    assert "listen 443 ssl" in files["nginx/site.d/listen-main.conf"]
    assert "certbot" not in env_of(files)["COMPOSE_PROFILES"]


def test_custom_subnet(bundle, secrets, facts):
    files = render.render(make_answers(advanced={"subnet": "10.77.3.0/24"}), secrets, facts, bundle)
    env = env_of(files)
    assert env["JW_NET_PREFIX"] == "10.77.3" and env["RP_LAN_IP"] == "10.77.3.2" and env["RBI_PUBLISH_IP"] == "10.77.3.1"


def test_gitea_version(bundle, secrets, facts):
    for version, image in (("latest", "gitea/gitea:latest"), ("1.25.2", "gitea/gitea:1.25.2")):
        a = make_answers(preset=None, zones=["git"], git={"version": version})
        assert env_of(render.render(a, secrets, facts, bundle))["GITEA_IMAGE"] == image


def test_storage_volume_spec():
    assert render.storage_volume(make_answers())["kind"] == "volume"
    spec = render.storage_volume(make_answers(storage={"kind": "local", "path": "/srv/workspace"}))
    assert spec["opts"] == {"type": "none", "o": "bind", "device": "/srv/workspace"}
    spec = render.storage_volume(make_answers(storage={"kind": "nfs", "server": "nas.example.com", "export": "/vol/ws"}))
    assert spec["opts"]["type"] == "nfs" and spec["opts"]["device"] == ":/vol/ws"
    assert spec["opts"]["o"].startswith("addr=nas.example.com,")


def test_render_is_pure(bundle, secrets, facts):
    a = make_answers(**CASES["full"])
    s = {**secrets, "DKIM_PRIVATE_KEY": DKIM_KEY}
    assert render.render(a, s, facts, bundle) == render.render(a, s, facts, bundle)


def test_file_modes():
    assert render.file_mode(".env") == 0o600
    assert render.file_mode("mailserver/config/rspamd/dkim/default.private") == 0o600
    assert render.file_mode("init/init-db.sh") == 0o755
    assert render.file_mode("nginx/nginx.conf") == 0o644


def test_merge_lines_keeps_existing_accounts():
    existing = "noreply@example.com|{SSHA512}old\nalice@example.com|{SHA512-CRYPT}x\n"
    rendered = "noreply@example.com|{SSHA512}new\nadmin@example.com|{SSHA512}y\n"
    assert render.merge_lines(existing, rendered) == existing + "admin@example.com|{SSHA512}y\n"


def test_oauth_clients_merge():
    out = render.oauth_clients('{"other":{"secret":"s"}}', "gitea", {"secret": "g"})
    assert json.loads(out) == {"other": {"secret": "s"}, "gitea": {"secret": "g"}}
    assert json.loads(render.oauth_clients(out, "gitea", None)) == {"other": {"secret": "s"}}
    assert render.oauth_clients("not json", "gitea", None) == "{}"


def test_dkim_public_value():
    from app import dkim

    pem = dkim.generate_private_key()
    value = render.dkim_public_value(pem)
    assert value.startswith("v=DKIM1; k=rsa; p=MIIB")
    assert render.dkim_public_value(pem) == value


def test_bundle_compose_uses_the_variables_render_writes(bundle):
    """렌더링이 .env 에 쓰는 변수를 compose 가 실제로 읽는가(이름이 어긋나면 조용히 무시된다)."""
    compose = bundle.read("docker-compose.yml")
    for name in ("JW_NET_PREFIX", "HAIRPIN_HOST", "RP_LAN_IP", "GITEA_IMAGE", "GIT_SSH_DOMAIN", "STORAGE_VOLUME",
                 "LIVEKIT_TURN_TLS_PUBLISH", "ACME_DOMAINS", "MAIL_SSL_TYPE", "JW_REGISTRY", "JW_VERSION",
                 "AUDIORELAY_WT_CERT", "JW_ZONES"):
        assert "${" + name in compose, name
    assert "./nginx/site.d:/etc/nginx/site.d:ro" in compose
    nginx = bundle.read("nginx/nginx.conf")
    for inc in ("site.d/http.conf", "site.d/listen-main.conf", "site.d/listen-rbi.conf"):
        assert f"include /etc/nginx/{inc};" in nginx
    assert "include /etc/nginx/site.d/headers.conf;" in bundle.read("nginx/security-headers.conf")


# ─── 격리 브라우저: 워크스페이스 자신의 주소 ───


@pytest.mark.parametrize("known,expected", [
    (dict(host_address="192.168.10.20", gateway="192.168.10.1"), "192.168.10.20,192.168.10.1"),
    (dict(host_address="192.168.10.20"), "192.168.10.20"),
    (dict(host_address="192.168.10.20", gateway="192.168.10.1", proxy_lan_ip="192.168.10.5"), "192.168.10.20,192.168.10.1,192.168.10.5"),
    (dict(host_address="192.168.10.20", gateway="192.168.10.20"), "192.168.10.20"),      # 같은 주소는 한 번만
    (dict(host_address="203.0.113.10", gateway="203.0.113.1"), ""),                    # 공인 주소는 대상이 될 수 없어 적지 않는다
    (dict(host_address="not-an-ip", gateway="127.0.0.1"), ""),
    (dict(), ""),
])
def test_rbi_protected_lists_this_servers_private_addresses(known, expected):
    assert render.rbi_protected(ans.Facts(**known)) == expected


def test_rbi_protected_is_written_only_with_the_rbi_zone(bundle, secrets, facts):
    facts.host_address, facts.gateway = "192.168.10.20", "192.168.10.1"
    env = env_of(render.render(make_answers(**CASES["full"]), {**secrets, "DKIM_PRIVATE_KEY": DKIM_KEY}, facts, bundle))
    assert env["RBI_PROTECTED"] == "192.168.10.20,192.168.10.1"
    env = env_of(render.render(make_answers(**CASES["minimal"]), secrets, facts, bundle))
    assert "RBI_PROTECTED" not in env
