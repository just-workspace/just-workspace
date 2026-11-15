"""답변 검증 — 모양, 조합 오류, 꺼진 구역 무시, 메모리 판정, 비밀 분리."""

import pytest

from app import answers as ans
from app.catalog import MIN_MEMORY_MB, nominal_memory_mb
from tests.conftest import make_answers


def codes(errors):
    return {(e.field, e.code) for e in errors}


def test_typical_answers_are_valid(catalog, facts):
    assert ans.validate(make_answers(), catalog, facts) == []


def test_unknown_field_and_bad_enum_are_structure_errors():
    with pytest.raises(ans.StructureError) as e:
        ans.load({"access": {"domain": "a.example.com", "tls": "auto"}})
    assert ("access.tls", "unknown_field") in codes(e.value.errors)
    with pytest.raises(ans.StructureError):
        ans.load({"storage": {"kind": "smb"}})
    with pytest.raises(ans.StructureError):
        ans.load({"version": 99})
    with pytest.raises(ans.StructureError):
        ans.load(["not", "a", "dict"])


def test_proxy_requires_proxy_cert_and_addresses(catalog, facts):
    a = make_answers(access={"network": "proxy", "cert": "auto"})
    got = codes(ans.validate(a, catalog, facts))
    assert ("access.cert", "cert_not_proxy_behind_proxy") in got
    assert ("access.proxy_addresses", "required") in got

    a = make_answers(access={"network": "proxy", "cert": "proxy", "proxy_addresses": ["192.168.10.5", "10.0.0.0/8"]})
    assert ans.validate(a, catalog, facts) == []

    a = make_answers(access={"network": "proxy", "cert": "proxy", "proxy_addresses": ["not-an-ip"]})
    assert ("access.proxy_addresses.0", "cidr_invalid") in codes(ans.validate(a, catalog, facts))


def test_proxy_cert_without_proxy_network(catalog, facts):
    a = make_answers(access={"network": "direct", "cert": "proxy"})
    assert ("access.cert", "cert_proxy_without_proxy") in codes(ans.validate(a, catalog, facts))


def test_temporary_cert_only_when_dns_does_not_match_or_after_failure(catalog):
    a = make_answers(access={"cert": "temporary"})
    f = ans.Facts(memory_mb=16000, dns_status="match")
    assert ("access.cert", "cert_temporary_not_allowed") in codes(ans.validate(a, catalog, f))
    for status in ("mismatch", "unknown"):
        assert ans.validate(a, catalog, ans.Facts(memory_mb=16000, dns_status=status)) == []
    assert ans.validate(a, catalog, ans.Facts(memory_mb=16000, dns_status="match", cert_issue_failed=True)) == []
    # 아직 확인하지 않았다면 확인부터
    assert ("access.cert", "cert_temporary_needs_dns_check") in codes(ans.validate(a, catalog, ans.Facts()))


def test_ip_address_cannot_use_auto_cert(catalog, facts):
    a = make_answers(access={"domain": "203.0.113.10", "cert": "auto"}, preset="minimal")
    assert ("access.cert", "cert_auto_needs_domain") in codes(ans.validate(a, catalog, facts))
    a = make_answers(access={"domain": "203.0.113.10", "cert": "temporary"}, preset="minimal")
    assert ans.validate(a, catalog, facts) == []


def test_upload_cert_needs_files(catalog, facts):
    a = make_answers(access={"cert": "upload"})
    assert ("access.cert", "cert_upload_missing") in codes(ans.validate(a, catalog, facts))
    facts.upload_cert_ok = True
    assert ans.validate(a, catalog, facts) == []
    a = make_answers(access={"cert": "upload", "cert_path": "/etc/passwd", "key_path": "/data/../etc/x"})
    got = codes(ans.validate(a, catalog, ans.Facts(memory_mb=16000, dns_status="match")))
    assert ("access.cert_path", "path_outside_data") in got and ("access.key_path", "path_outside_data") in got


def test_nfs_requires_server_and_export(catalog, facts):
    a = make_answers(storage={"kind": "nfs"})
    got = codes(ans.validate(a, catalog, facts))
    assert ("storage.server", "required") in got and ("storage.export", "required") in got
    a = make_answers(storage={"kind": "nfs", "server": "192.168.10.9", "export": "/export/ws"})
    assert ans.validate(a, catalog, facts) == []


def test_disabled_zone_fields_are_ignored(catalog, facts):
    # 메일 구역이 꺼져 있으면 메일 항목이 엉망이어도 오류가 아니다
    a = make_answers(preset=None, zones=["chat"], mail={"kind": "external", "host": "bad host!", "port": 99999})
    assert ans.validate(a, catalog, facts) == []
    # 켜면 오류
    a = make_answers(preset=None, zones=["mail"], mail={"kind": "external", "host": "bad host!", "port": 99999})
    got = codes(ans.validate(a, catalog, facts))
    assert ("mail.host", "host_invalid") in got and ("mail.port", "port_invalid") in got
    assert ("mail.password", "required") in got


def test_ai_provider_rules(catalog, facts):
    base = dict(preset=None, zones=["ai"])
    assert ans.validate(make_answers(**base, ai={"mode": "later"}), catalog, facts) == []
    got = codes(ans.validate(make_answers(**base, ai={"mode": "provider", "provider": "nope"}), catalog, facts))
    assert ("ai.provider", "provider_unknown") in got
    got = codes(ans.validate(make_answers(**base, ai={"mode": "provider", "provider": "openai", "model": "m"}),
                             catalog, facts))
    assert ("ai.api_key", "required") in got
    got = codes(ans.validate(make_answers(**base, ai={"mode": "provider", "provider": "compatible", "model": "m"}),
                             catalog, facts))
    assert ("ai.base_url", "required") in got and ("ai.api_key", "required") not in got


def test_meetings_rules(catalog, facts):
    a = make_answers(preset=None, zones=["meetings"], meetings={"lossless_audio": True})
    assert ("meetings.lossless_audio", "lossless_needs_chat") in codes(ans.validate(a, catalog, facts))
    a = make_answers(preset=None, zones=["meetings"])
    assert ("meetings.public_ip", "required") in codes(ans.validate(a, catalog, ans.Facts(memory_mb=16000, dns_status="match")))
    assert ans.validate(a, catalog, facts) == []      # 감지값이 있으면 비워도 된다


def test_admin_rules(catalog, facts):
    a = make_answers(admin={"username": "Bad Name", "password": "short"})
    got = codes(ans.validate(a, catalog, facts))
    assert ("admin.username", "username_invalid") in got
    assert ("admin.password", "password_too_short") in got


def test_partial_save_skips_missing_required(catalog):
    a = ans.load({"access": {"domain": "ws.example.com"}})
    assert ans.validate(a, catalog, ans.Facts(), final=False) == []
    assert ans.validate(a, catalog, ans.Facts(), final=True) != []
    # 적힌 값이 틀리면 부분 저장에서도 알려 준다
    a = ans.load({"access": {"domain": "not a domain"}})
    assert ("access.domain", "domain_invalid") in codes(ans.validate(a, catalog, ans.Facts(), final=False))


def test_restore_is_out_of_scope(catalog, facts):
    assert ("mode", "restore_not_supported") in codes(ans.validate(make_answers(mode="restore"), catalog, facts))


def test_unknown_zone_and_preset(catalog, facts):
    got = codes(ans.validate(make_answers(preset="huge", zones=None), catalog, facts))
    assert ("preset", "preset_unknown") in got
    got = codes(ans.validate(make_answers(zones=["mail", "nope"], addons=["chat"]), catalog, facts))
    assert ("zones.1", "zone_unknown") in got and ("addons.0", "zone_unknown") in got


# ─── 메모리 ───


def test_nominal_memory_rounds_up_small_shortfall():
    assert nominal_memory_mb(3900) == 4096       # "4GB 서버"
    assert nominal_memory_mb(7820) == 8192
    assert nominal_memory_mb(3300) == 3300       # 차이가 크면 그대로
    assert nominal_memory_mb(0) == 0


def test_memory_verdict(catalog):
    full = catalog.presets["full"]
    need = catalog.recommend_mb(full)
    assert need == 4000 + sum(catalog.get(z)["memory_mb"]["recommend"] for z in full)
    assert catalog.judge(full, need).ok
    assert not catalog.judge(full, 6000).ok
    assert catalog.judge([], 3900).ok and not catalog.judge([], 3900).below_minimum
    assert catalog.judge([], 2000).below_minimum
    assert MIN_MEMORY_MB == 4096


def test_memory_errors_in_validation(catalog):
    a = make_answers(preset="full")
    got = codes(ans.validate(a, catalog, ans.Facts(memory_mb=6000, public_ip="203.0.113.10", dns_status="match")))
    assert ("zones", "memory_insufficient") in got
    got = codes(ans.validate(make_answers(preset="minimal"), catalog, ans.Facts(memory_mb=2000, dns_status="match")))
    assert ("zones", "memory_below_minimum") in got


def test_quick_mode_defaults_to_collab_and_downgrades(catalog):
    a = make_answers(mode="quick", preset=None)
    resolved, notes = ans.resolve_quick(a, catalog, ans.Facts(memory_mb=16000))
    assert resolved.zones == catalog.presets["collab"] and notes == []
    resolved, notes = ans.resolve_quick(a, catalog, ans.Facts(memory_mb=4096))
    assert resolved.zones == [] and resolved.preset == "minimal"
    assert notes[0]["key"] == "quick_downgraded" and notes[0]["vars"]["from"] == "collab"
    # 구역을 직접 골랐으면 건드리지 않는다
    a = make_answers(mode="quick", zones=["chat"])
    assert ans.resolve_quick(a, catalog, ans.Facts(memory_mb=4096))[0].zones == ["chat"]


def test_zone_listing_marks_fit(catalog):
    listing = catalog.listing(["mail"], 5200)
    by_id = {z["id"]: z for z in listing["zones"]}
    assert by_id["mail"]["selected"] and by_id["mail"]["fits"]
    assert by_id["chat"]["fits"] and not by_id["docs"]["fits"]
    assert listing["preset_fits"] == {"minimal": True, "collab": False, "full": False}
    assert listing["memory"]["need_mb"] == 5000


# ─── 비밀 분리 ───


def test_split_removes_secrets_and_join_restores():
    a = make_answers(preset=None, zones=["mail", "ai"],
                     mail={"kind": "external", "host": "smtp.example.com", "username": "u", "password": "p@ss w0rd"},
                     ai={"mode": "provider", "provider": "openai", "model": "m", "api_key": "sk-test"})
    public, secret = ans.split(a)
    dumped = str(public)
    assert "correct-horse-battery" not in dumped and "p@ss w0rd" not in dumped and "sk-test" not in dumped
    assert secret == {"admin.password": "correct-horse-battery", "mail.password": "p@ss w0rd", "ai.api_key": "sk-test"}
    assert ans.join(public, secret) == a
    assert ans.secrets_present(secret) == {"admin.password": True, "mail.password": True, "ai.api_key": True}


def test_merge_patch():
    cur = {"access": {"domain": "a.example.com", "cert": "auto"}, "zones": ["mail"]}
    out = ans.merge_patch(cur, {"access": {"cert": "upload"}, "zones": ["chat"], "preset": None})
    assert out == {"access": {"domain": "a.example.com", "cert": "upload"}, "zones": ["chat"]}
