"""사설 CA 가 내준 인증서 — CA 인증서를 따로 받는 칸(마법사·내부 API), 나중에 CA 만 더하기, 믿게 하는 범위."""

import datetime as dt

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from starlette.testclient import TestClient

from app import api, api_cert, certs, render, zones
from app.zonectl import ZoneRequestError
from tests.conftest import make_answers
from tests.test_api_tokens_cli import login, wizard  # noqa: F401 — 마법사 API 픽스처
from tests.test_cert_reissue import temporary_install
from tests.test_zones import finish


def _pem(cert) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def _key_pem(key) -> str:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption()).decode()


def _build(subject: str, issuer_name, issuer_key, *, ca: bool, names: list[str] | None = None, key=None):
    key = key or ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)])
    now = dt.datetime.now(dt.timezone.utc)
    b = (x509.CertificateBuilder().subject_name(name).issuer_name(issuer_name or name).public_key(key.public_key())
         .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(minutes=5))
         .not_valid_after(now + dt.timedelta(days=365))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    if names:
        b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName(n) for n in names]), critical=False)
    return b.sign(issuer_key or key, hashes.SHA256()), key


def private_ca(names=("ws.example.com",), *, intermediate: bool = False) -> dict:
    """사설 CA 하나와 그것이 내준 서버 인증서. intermediate 면 루트 → 중간 → 서버."""
    root, root_key = _build("Example Private Root CA", None, None, ca=True)
    signer, signer_key, mid_pem = root, root_key, ""
    if intermediate:
        signer, signer_key = _build("Example Private Issuing CA", root.subject, root_key, ca=True)
        mid_pem = _pem(signer)
    leaf, leaf_key = _build(names[0], signer.subject, signer_key, ca=False, names=list(names))
    return {"root": _pem(root), "mid": mid_pem, "leaf": _pem(leaf), "key": _key_pem(leaf_key)}


def check(report: dict, check_id: str) -> dict | None:
    return next((c for c in report["checks"] if c["id"] == check_id), None)


# ─── 검증 ───

def test_leaf_alone_warns_that_the_issuer_is_unknown():
    pki = private_ca()
    report = certs.inspect(pki["leaf"], pki["key"], "ws.example.com")
    assert report["ok"] and report["trust"] == "none"                          # 막지는 않는다 — 공개 CA 일 수 있다
    assert check(report, "chain") == {"id": "chain", "status": "warn", "value": None,
                                      "fix": {"key": "cert_chain_missing", "vars": {}}}
    assert check(report, "ca_readable") is None                                # CA 를 올리지 않았으면 그 검사도 없다


def test_separate_ca_is_checked_against_the_certificate():
    pki, other = private_ca(), private_ca()
    good = certs.inspect(pki["leaf"], pki["key"], "ws.example.com", ca_pem=pki["root"])
    assert good["ok"] and good["trust"] == "included"
    assert [check(good, i)["status"] for i in ("chain", "ca_readable", "ca_is_ca", "ca_issues_cert")] == ["pass"] * 4

    def failed(ca: str) -> str:
        report = certs.inspect(pki["leaf"], pki["key"], "ws.example.com", ca_pem=ca)
        assert not report["ok"]
        return next(c["fix"]["key"] for c in report["checks"] if c["status"] == "fail")

    assert failed(other["root"]) == "ca_not_issuer"                            # 엉뚱한 CA
    assert failed(pki["leaf"]) == "ca_not_a_ca"                                # 서버 인증서를 CA 칸에
    assert failed(pki["key"]) == "ca_is_private_key"                           # 개인 키를 CA 칸에
    assert failed("not a pem") == "ca_not_pem"


def test_root_uploaded_for_a_chain_that_ends_at_an_intermediate():
    pki = private_ca(intermediate=True)
    # 인증서 파일에 서버 + 중간, CA 칸에 루트 — 체인의 끝(중간)을 루트가 내줬다
    report = certs.inspect(pki["leaf"] + pki["mid"], pki["key"], "ws.example.com", ca_pem=pki["root"])
    assert report["ok"] and check(report, "ca_issues_cert")["status"] == "pass"
    assert certs.trust_pem(pki["leaf"] + pki["mid"], pki["root"]) == pki["mid"] + pki["root"]
    # 같은 인증서가 양쪽에 있어도 한 번만 싣는다
    assert certs.trust_pem(pki["leaf"] + pki["mid"], pki["mid"] + pki["root"]) == pki["mid"] + pki["root"]
    assert certs.trust_pem(pki["leaf"]) == "" and certs.trust_pem(pki["leaf"], "") == ""
    assert certs.trust_pem(pki["leaf"], "garbage") == ""


def test_self_signed_certificate_has_no_chain_warning():
    cert, key = certs.self_signed(["ws.example.com"])
    report = certs.inspect(cert, key, "ws.example.com")
    assert report["trust"] == "self_signed" and check(report, "chain") is None


def test_answers_ca_path_must_be_under_data(catalog):
    from app import answers as ans

    def codes(ca_path):
        a = ans.load({"access": {"domain": "ws.example.com", "cert": "upload", "cert_path": "/data/c.pem",
                                 "key_path": "/data/k.pem", "ca_path": ca_path},
                      "admin": {"username": "admin", "password": "long-enough-password"}})
        return [(e.field, e.code) for e in ans.validate(a, catalog, ans.Facts(memory_mb=16000, cpus=4))]

    assert ("access.ca_path", "path_outside_data") in codes("/etc/ssl/ca.pem")
    assert not [c for c in codes("/data/certs/ca.pem") if c[0] == "access.ca_path"]


# ─── 마법사: 올리기 ───

def test_wizard_keeps_the_separate_ca(wizard):
    _, svc, client = wizard
    login(svc, client)
    svc.store.save_answers(make_answers(access={"cert": "upload"}))
    pki = private_ca()
    ca_file = svc.store.dir / "upload" / "ca.pem"

    r = client.post("/api/probe/cert", json={"cert": pki["leaf"], "key": pki["key"], "ca": pki["leaf"]}).json()
    assert not r["ok"] and not ca_file.exists()                                # CA 칸이 틀리면 아무것도 받아 두지 않는다
    assert not svc.store.facts().upload_cert_ok
    r = client.post("/api/probe/cert", json={"cert": pki["leaf"], "key": pki["key"], "ca": pki["root"]}).json()
    assert r["ok"] and r["trust"] == "included" and ca_file.read_text(encoding="utf-8") == pki["root"]
    # CA 없이 다시 확인하면 앞서 받아 둔 CA 를 치운다(다른 인증서로 바꾼 경우)
    r = client.post("/api/probe/cert", json={"cert": pki["leaf"], "key": pki["key"]}).json()
    assert r["ok"] and r["trust"] == "none" and not ca_file.exists()
    assert client.post("/api/probe/cert", json={"cert": "x", "key": "y", "ca": "c" * 200_001}).status_code == 413


def test_unattended_ca_path_wins_over_the_uploaded_file(tmp_path):
    """무인 설치 — 답변 파일의 `access.ca_path` 가 있으면 그것을, 없으면 화면·내부 API 가 받아 둔 파일을 읽는다."""
    from types import SimpleNamespace

    from app import engine as eng

    state = tmp_path / "state"
    (state / "upload").mkdir(parents=True)
    (tmp_path / "given.pem").write_text("GIVEN", encoding="utf-8")

    def ctx(ca_path):
        return SimpleNamespace(answers=SimpleNamespace(access=SimpleNamespace(ca_path=ca_path)), paths=SimpleNamespace(state=state))

    assert eng.uploaded_ca(ctx(None)) == ""                                    # 올린 것이 없다
    (state / "upload" / "ca.pem").write_text("UPLOADED", encoding="utf-8")
    assert eng.uploaded_ca(ctx(None)) == "UPLOADED"
    assert eng.uploaded_ca(ctx(str(tmp_path / "given.pem"))) == "GIVEN"
    assert eng.uploaded_ca(ctx(str(tmp_path / "missing.pem"))) == ""


def test_install_with_separate_ca_trusts_it(tmp_path):
    from app.state import write_private
    from tests.test_zones import gitea_host

    pki = private_ca()
    host = gitea_host(tmp_path)
    svc = host.install(preset=None, zones=["git"], mail={}, access={"cert": "upload"})
    write_private(svc.store.dir / "upload" / "cert.pem", pki["leaf"])          # 화면에서 올린 것
    write_private(svc.store.dir / "upload" / "key.pem", pki["key"])
    write_private(svc.store.dir / "upload" / "ca.pem", pki["root"], 0o644)
    svc.store.update_facts(upload_cert_ok=True)
    state = svc.engine.run()
    assert state["status"] == "done", state["error"]
    site = (host.paths.stack / render.SITE_COMPOSE).read_text(encoding="utf-8")
    assert (host.paths.stack / render.SITE_CA_FILE).read_text(encoding="utf-8") == pki["root"]
    for service in ("gitea", "backend"):
        assert f"  {service}:\n    volumes:\n      - ./site-ca/ca.pem:{render.SITE_CA_MOUNT}:ro\n" in site
    assert zones.pending(svc.store) == {}                                      # 로그인 연동이 설치 때 바로 걸린다


# ─── 설치 뒤: 인증서와 함께, 또는 CA 만 ───

def test_reissue_with_separate_ca_connects_the_git_login(tmp_path):
    host, svc = temporary_install(tmp_path)
    pki = private_ca()
    mgr = api_cert.manager(svc)
    assert mgr.status()["site_ca"] is False and mgr.status()["ca_uploadable"] is False
    with pytest.raises(ZoneRequestError) as e:
        mgr.reissue({"mode": "upload", "cert": pki["leaf"], "key": pki["key"], "ca": private_ca()["root"]})
    assert (e.value.status, e.value.code) == (422, "cert_invalid")

    host.trusted = True
    job = finish(svc, mgr.reissue({"mode": "upload", "cert": pki["leaf"], "key": pki["key"], "ca": pki["root"]}))
    assert job["status"] == "done", job["error"]
    assert (host.paths.stack / render.SITE_CA_FILE).read_text(encoding="utf-8") == pki["root"]
    assert zones.pending(svc.store) == {}
    status = mgr.status()
    assert status["site_ca"] is True and status["ca_uploadable"] is True and status["mode"] == "upload"


def test_ca_alone_can_be_added_later_and_removed(tmp_path):
    from tests.fakes import seq

    host, svc = temporary_install(tmp_path)
    pki = private_ca()
    mgr = api_cert.manager(svc)
    site = host.paths.stack / render.SITE_COMPOSE
    ca_file = host.paths.stack / render.SITE_CA_FILE

    with pytest.raises(ZoneRequestError) as e:                                 # 임시 인증서에는 더할 CA 가 없다
        mgr.set_ca({"ca": pki["root"]})
    assert (e.value.status, e.value.code) == (409, "cert_ca_needs_upload")

    # 서버 인증서 한 장만 올렸다 — 연결은 보류로 남는다
    job = finish(svc, mgr.reissue({"mode": "upload", "cert": pki["leaf"], "key": pki["key"]}))
    assert zones.pending(svc.store)["git"] and not ca_file.exists()
    status = mgr.status()
    assert status["site_ca"] is False and status["ca_uploadable"] is True and status["pending"] == ["git"]

    with pytest.raises(ZoneRequestError) as e:                                 # 그 인증서를 내주지 않은 CA
        mgr.set_ca({"ca": private_ca()["root"]})
    assert (e.value.status, e.value.code) == (422, "cert_invalid")
    assert [c["fix"]["key"] for c in e.value.vars["checks"] if c["status"] == "fail"] == ["ca_not_issuer"]

    # CA 만 더한다 — 인증서는 다시 놓지 않고, 컨테이너를 다시 만든 뒤 보류된 연결을 건다
    host.trusted = True
    before = len(host.runner.calls)
    job = finish(svc, mgr.set_ca({"ca": pki["root"]}))
    assert job["status"] == "done", job["error"]
    assert job["kind"] == "cert" and [s["id"] for s in job["stages"]] == ["issue", "reload", "reconnect"]
    assert ca_file.read_text(encoding="utf-8") == pki["root"] and "site-ca/ca.pem" in site.read_text(encoding="utf-8")
    assert (svc.store.dir / "upload" / "ca.pem").read_text(encoding="utf-8") == pki["root"]
    assert zones.pending(svc.store) == {} and mgr.status()["site_ca"] is True
    calls = host.runner.calls[before:]
    assert not any(seq("place-cert")(c) for c in calls)                        # 인증서·키는 건드리지 않는다
    recreate = [i for i, c in enumerate(calls) if seq("compose", "up", "-d", "gitea")(c)][-1]
    connect = [i for i, c in enumerate(calls) if seq("exec", "ws-gitea", "auth", "add-oauth")(c)][-1]
    assert recreate < connect
    assert any(seq("compose", "up", "-d", "backend")(c) for c in calls)        # backend 도 CA 를 붙여 다시 뜬다

    # 걷어 내기
    job = finish(svc, mgr.set_ca({"ca": ""}))
    assert job["status"] == "done", job["error"]
    assert not ca_file.exists() and "site-ca" not in site.read_text(encoding="utf-8") and mgr.status()["site_ca"] is False


def test_internal_api_route_for_ca(tmp_path):
    host, svc = temporary_install(tmp_path)
    pki = private_ca()
    finish(svc, api_cert.manager(svc).reissue({"mode": "upload", "cert": pki["leaf"], "key": pki["key"]}))
    client = TestClient(api.create_internal_app(svc), client=("172.28.0.10", 50000))
    headers = {api.KEY_HEADER: svc.store.env_secrets()["JW_INSTALLER_KEY"]}
    assert client.post("/internal/cert/ca", json={"ca": pki["root"]}).status_code == 404        # 키 없이
    r = client.post("/internal/cert/ca", json={"ca": pki["leaf"]}, headers=headers)
    assert r.status_code == 422 and r.json()["code"] == "cert_invalid"
    host.trusted = True
    r = client.post("/internal/cert/ca", json={"ca": pki["root"]}, headers=headers)
    assert r.status_code == 202 and r.json()["kind"] == "cert"
    assert finish(svc, r.json())["status"] == "done"
    assert client.get("/internal/cert", headers=headers).json()["site_ca"] is True
