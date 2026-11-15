"""입력 검증(주입 시도)과 `.env` 이스케이프."""

import pytest

from app import envfile
from app import validators as v
from app.bundle import MANIFEST, Bundle

INJECTIONS = [
    "example.com; rm -rf /", "example.com\nEVIL=1", "$(id).example.com", "`id`.example.com",
    "a b.example.com", "example.com/../x", "-oProxyCommand=x", "example..com", "", ".example.com",
    "exa_mple.com", "example.com|cat", "example.com'", 'example.com"', "x" * 300 + ".com",
]


@pytest.mark.parametrize("value", INJECTIONS)
def test_domain_rejects_injection(value):
    with pytest.raises(v.Invalid):
        v.domain(value)


def test_domain_accepts_and_normalizes():
    assert v.domain(" WS.Example.COM. ") == "ws.example.com"
    assert v.domain("a-b.c1.example.co.kr") == "a-b.c1.example.co.kr"
    assert v.address("203.0.113.7") == "203.0.113.7"
    with pytest.raises(v.Invalid):
        v.domain("localhost")          # 점이 없다
    with pytest.raises(v.Invalid):
        v.domain("203.0.113.7")        # 주소는 domain 이 아니다(address 로 받는다)


@pytest.mark.parametrize("value", ["10.0.0.0/8; x", "10.0.0.1 10.0.0.2", "::1", "300.1.1.1", "10.0.0.0/33", "a/24", ""])
def test_cidr_rejects(value):
    with pytest.raises(v.Invalid):
        v.cidr(value)


def test_cidr_and_subnet():
    assert v.cidr("192.168.10.5") == "192.168.10.5"
    assert v.cidr("10.1.2.3/8") == "10.0.0.0/8"
    assert v.subnet24("172.28.0.7/24") == "172.28.0.0/24"
    assert v.net_prefix("10.77.3.0/24") == "10.77.3"
    for bad in ("172.28.0.0/16", "8.8.8.0/24", "127.0.0.0/24", "169.254.1.0/24", "x"):
        with pytest.raises(v.Invalid):
            v.subnet24(bad)


@pytest.mark.parametrize("value", [
    "relative/path", "/srv/../etc", "/srv/a b", "/srv/$(id)", "/srv/a;b", "/srv/a,b", "/", "/etc/ssl", "/proc/1",
    "/srv//x", "/srv/a\nb", "/srv/a'b", "/usr", "/srv/./x", "",
])
def test_host_path_rejects(value):
    with pytest.raises(v.Invalid):
        v.host_path(value)


def test_host_path_accepts():
    assert v.host_path("/srv/workspace-data/files_1") == "/srv/workspace-data/files_1"
    assert v.host_path("/mnt/disk2/") == "/mnt/disk2"


@pytest.mark.parametrize("value", ["export", "/export,ro", "/export a", "/export:evil", "/a/../b", "/e\tx", "/ex=1"])
def test_nfs_export_rejects(value):
    with pytest.raises(v.Invalid):
        v.nfs_export(value)


def test_nfs_and_hostname():
    assert v.nfs_export("/volume1/workspace") == "/volume1/workspace"
    assert v.hostname("NAS01") == "nas01" and v.hostname("192.168.10.9") == "192.168.10.9"
    for bad in ("nas,addr=evil", "nas 01", "nas;", "-nas", ""):
        with pytest.raises(v.Invalid):
            v.hostname(bad)


def test_username_tag_url():
    assert v.username("Admin.User") == "admin.user"
    for bad in ("ab", "a b", "admin;", "../x", "-abc"):
        with pytest.raises(v.Invalid):
            v.username(bad)
    assert v.image_tag("1.25.2-rootless") == "1.25.2-rootless"
    for bad in ("latest;rm", "a b", "", "x/y", "-x", "a@sha256:1"):
        with pytest.raises(v.Invalid):
            v.image_tag(bad)
    assert v.http_url("https://llm.example.com/v1/") == "https://llm.example.com/v1"
    for bad in ("ftp://x.example.com", "https://user:pw@x.example.com", "https://x.example.com/?a=1",
                "javascript:alert(1)", "https://", "http://x.example.com/a b"):
        with pytest.raises(v.Invalid):
            v.http_url(bad)


# ─── .env ───

NASTY = [
    "plain", "", "with space", "pa$$word", "${HOME}", "$HOME", "a#b", "a #comment", "quote'single", 'quote"double',
    "back\\slash", "both'and\"", "it's ${X} \\ \"y\"", "=leading", "trailing ", "한글 값", '{"a":{"b":["c"]}}',
    "a=b=c", "`cmd`", "$(cmd)", "!bang", "semi;colon", "tab\there",
]


@pytest.mark.parametrize("value", NASTY)
def test_env_roundtrip(value):
    text = envfile.render([("t", [("KEY", value), ("NEXT", "after")])])
    parsed = envfile.parse(text)
    assert parsed["KEY"] == value and parsed["NEXT"] == "after"
    assert len([line for line in text.splitlines() if line.startswith("KEY=")]) == 1


def test_env_quote_shapes():
    assert envfile.quote("abc-123_x.y:z/@") == "abc-123_x.y:z/@"
    assert envfile.quote("a b") == "'a b'"
    assert envfile.quote("$HOME") == "'$HOME'"                 # 작은따옴표 안은 치환되지 않는다
    assert envfile.quote("it's $x") == '"it\'s \\$x"'


@pytest.mark.parametrize("value", ["line1\nline2", "cr\rx", "nul\x00x"])
def test_env_rejects_multiline(value):
    with pytest.raises(envfile.EnvValueError):
        envfile.quote(value)


def test_env_rejects_bad_or_duplicate_keys():
    with pytest.raises(envfile.EnvValueError):
        envfile.render([("t", [("BAD KEY", "x")])])
    with pytest.raises(envfile.EnvValueError):
        envfile.render([("t", [("A", "1")]), ("u", [("A", "2")])])


def test_env_update_in_place_and_append():
    text = envfile.render([("t", [("A", "1"), ("B", "two words")])])
    out = envfile.update(text, {"B": "x$y", "C": "new"})
    assert envfile.parse(out) == {"A": "1", "B": "x$y", "C": "new"}
    assert out.index("B=") < out.index("C=") and out.count("B=") == 1


# ─── 번들 ───


def test_bundle_manifest_sources_exist():
    b = Bundle()
    for name in MANIFEST:
        assert b.path(name).is_file(), name
    assert b.version and b.version[0].isdigit()
    assert b.gitea_verified_image.startswith("gitea/gitea@sha256:")


def test_bundle_build_copies_everything(tmp_path):
    from app import bundle

    names = bundle.build(bundle.repo_root(), tmp_path)
    assert sorted(names) == sorted(MANIFEST)
    built = Bundle(tmp_path)
    assert built.zones == Bundle().zones and built.version == Bundle().version
    assert built.read("docker-compose.yml") == Bundle().read("docker-compose.yml")


def test_bundle_secret_table_is_the_backend_table():
    sd = Bundle().security_defaults
    names = sd.names(default_only=True)
    assert "SECRET_KEY" in names and "DB_PASSWORD" in names and "SMTP_PASSWORD" not in names
    values = sd.generate()
    assert set(values) == set(names)
    assert all(sd.weakness(sd.spec(n), val) is None for n, val in values.items())
