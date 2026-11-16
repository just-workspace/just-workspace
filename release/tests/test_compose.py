import json

import pytest

from jwrelease import compose
from jwrelease.compose import ComposeError, ImageRef, expand

from conftest import PINS, REPO_ROOT, fake_digest

ENV = {"JW_REGISTRY": "ghcr.io/just-workspace", "JW_VERSION": "1.0.0"}

# ── 현재 docker-compose.yml 스냅샷 ───────────────────────────
# compose 의 이미지 구성이 바뀌면 여기가 깨진다 — 워크플로 매트릭스·문서도 함께 고쳐야 한다는 신호다.

OWN_SNAPSHOT = {
    "backend": ("backend", "Dockerfile", "runtime"),
    "frontend-react": ("frontend-react", "Dockerfile", None),
    "mailserver": ("mailserver/image", "Dockerfile", None),
    "sso": ("sso", "Dockerfile", None),
    "ldap": ("ldap", "Dockerfile", None),
    "audiorelay": ("audiorelay", "Dockerfile", None),
    "rbi-netfilter": ("deploy/rbi-netfilter", "Dockerfile", None),
    "rbi-mirror": ("rbi/mirror", "Dockerfile", "prod"),
    "docconv": ("docconv", "Dockerfile", None),
    "sandbox": ("sandbox", "Dockerfile", None),
}

THIRD_PARTY_SNAPSHOT = {
    "postgres": ("postgres", "core"),
    "redis": ("redis", "core"),
    "nginx": ("nginx", "core"),
    "certbot": ("certbot/certbot", "core"),
    "gitea": ("gitea/gitea", "git"),
    "livekit": ("livekit/livekit-server", "meetings"),
    "egress": ("livekit/egress", "meetings"),
    "onlyoffice": ("onlyoffice/documentserver", "docs"),
    "searxng": ("searxng/searxng", "ai"),
}

# 리포의 compose 는 남의 이미지를 전부 다이제스트로 고정한다(태그는 `이름:태그@sha256:…` 로 함께 남긴다).
UNPINNED_SNAPSHOT: set[str] = set()
TAG_AND_DIGEST = {"postgres", "redis", "nginx", "egress"}


@pytest.fixture(scope="module")
def images(compose_text):
    return compose.read_images(compose_text, ENV)


@pytest.fixture(scope="module")
def unpinned_images(unpinned_compose_text):
    """다이제스트 고정을 뗀 사본 — 고정이 빠졌을 때의 동작(실패·pins·resolver)을 본다."""
    return compose.read_images(unpinned_compose_text, ENV)


def test_own_images_snapshot(images):
    own = {i.service: (i.build.context, i.build.dockerfile, i.build.target) for i in compose.own_images(images)}
    assert own == OWN_SNAPSHOT
    assert len(own) == 10


def test_own_image_names_follow_registry_and_prefix(images):
    for i in compose.own_images(images):
        assert i.ref.repository == f"ghcr.io/just-workspace/just-workspace-{i.service}"
        assert i.ref.digest is None
        assert (REPO_ROOT / i.build.dockerfile_path).is_file(), i.build.dockerfile_path


def test_third_party_snapshot(images, zones_raw):
    zone_of = compose.service_zones(json.loads(zones_raw))
    third = {i.service: (i.ref.repository, zone_of.get(i.service)) for i in compose.third_party_images(images)}
    assert third == THIRD_PARTY_SNAPSHOT


def test_unpinned_third_party_snapshot(images):
    assert {i.service for i in compose.unpinned_third_party(images)} == UNPINNED_SNAPSHOT
    assert all(i.ref.pinned for i in compose.third_party_images(images))
    assert {i.service for i in compose.third_party_images(images) if i.ref.tag} == TAG_AND_DIGEST


def test_repo_pins_match_example_table(images):
    """compose 에 적은 다이제스트와 예시 표(release/examples/pins.json)가 어긋나지 않게."""
    table = json.loads((REPO_ROOT / "release" / "examples" / "pins.json").read_text(encoding="utf-8"))
    in_compose = {i.ref.by_tag(): i.ref.digest for i in compose.third_party_images(images) if i.ref.tag}
    assert in_compose == table


def test_unpinned_copy_has_tag_only(unpinned_images):
    assert {i.service for i in compose.unpinned_third_party(unpinned_images)} == TAG_AND_DIGEST
    for i in compose.unpinned_third_party(unpinned_images):
        assert i.ref.tag and not i.ref.pinned


def test_defaults_used_when_env_missing(compose_text):
    by_name = {i.service: i for i in compose.read_images(compose_text, {})}
    assert str(by_name["backend"].ref) == "localhost/just-workspace-backend:latest"
    assert by_name["gitea"].ref.repository == "gitea/gitea" and by_name["gitea"].ref.pinned   # ${GITEA_IMAGE:-…} 의 기본값


def test_profiles_read(images):
    by_name = {i.service: i for i in images}
    assert by_name["backend"].profiles == ()
    assert by_name["sso"].profiles == ("sso",)
    assert by_name["searxng"].profiles == ("aitools",)
    assert by_name["rbi-mirror"].profiles == ("rbi-build",)


def test_matches_pyyaml(compose_text):
    """직접 만든 읽기가 PyYAML 과 같은 결과를 내는지(image·build·profiles 전부)."""
    yaml = pytest.importorskip("yaml")
    doc = yaml.safe_load(compose_text)
    mine = compose.parse_services(compose_text)
    assert list(mine) == list(doc["services"])
    for name, svc in doc["services"].items():
        assert mine[name]["image"] == svc.get("image"), name
        assert mine[name]["profiles"] == (svc.get("profiles") or []), name
        build = svc.get("build")
        if build is None:
            assert mine[name]["build"] is None, name
            continue
        if isinstance(build, str):
            build = {"context": build}
        expected = {k: build[k] for k in ("context", "dockerfile", "target") if k in build}
        assert mine[name]["build"] == expected, name


# ── 읽기 규칙 ────────────────────────────────────────────────

SAMPLE = """\
# 머리말
x-common: &common
  restart: always

services:
  app:   # 우리 것
    image: "${REG:-localhost}/app:${VER:-latest}"   # 따옴표 + 주석
    build:
      context: ./app
      dockerfile: Dockerfile.prod
      target: runtime
      args:
        context: not-this
    profiles:
      - one
      - "two"
    environment:
      image: not-an-image
      NOTE: "값에 # 이 있어도 주석이 아니다"
    entrypoint:
      - /bin/sh
      - -c
      - |
        image: also-not
        echo "$${HOME}"
  short:
    build: ./short
    image: 'short:1'
  db:
    image: postgres:16@sha256:%(d)s
  cache:
    image: redis:7   # 태그만

volumes:
  image:
    name: nope
""" % {"d": "a" * 64}


def test_reads_only_what_it_should():
    services = compose.parse_services(SAMPLE)
    assert list(services) == ["app", "short", "db", "cache"]
    assert services["app"] == {
        "image": "${REG:-localhost}/app:${VER:-latest}",
        "build": {"context": "./app", "dockerfile": "Dockerfile.prod", "target": "runtime"},
        "profiles": ["one", "two"],
    }
    assert services["short"] == {"image": "short:1", "build": {"context": "./short"}, "profiles": []}
    assert services["cache"]["image"] == "redis:7"

    images = compose.read_images(SAMPLE, {"REG": "r.example/ns", "VER": "2.0.0"})
    app = images[0]
    assert str(app.ref) == "r.example/ns/app:2.0.0" and app.build.dockerfile_path == "app/Dockerfile.prod"
    assert [i.service for i in compose.unpinned_third_party(images)] == ["cache"]


def test_matches_pyyaml_on_sample():
    yaml = pytest.importorskip("yaml")
    doc = yaml.safe_load(SAMPLE)["services"]
    mine = compose.parse_services(SAMPLE)
    for name in doc:
        assert mine[name]["image"] == doc[name]["image"]
        assert mine[name]["profiles"] == doc[name].get("profiles", [])


@pytest.mark.parametrize(
    "text",
    [
        "volumes:\n  a:\n",                                           # services 없음
        "services:\n",                                                # 비어 있음
        "services:\n  a:\n    image: *anchor\n",                      # 별칭
        "services:\n  a:\n    image: |\n      x\n",                   # 여러 줄 값
        "services:\n  a:\n    image: \"unterminated\n",
        "services:\n  a:\n    <<: *common\n    image: x:1\n",         # 병합 키 — image 가 다른 데서 올 수 있다
        "services:\n  a:\n    build:\n      dockerfile: D\n    image: x\n",   # context 없음
        "services:\n  a:\n\tfoo: 1\n",                                # 탭
        "services:\n  a:\n    image: x:1\n  a:\n    image: y:1\n",    # 중복
    ],
)
def test_refuses_what_it_cannot_read_safely(text):
    with pytest.raises(ComposeError):
        compose.parse_services(text)


def test_service_without_image_refused():
    with pytest.raises(ComposeError):
        compose.read_images("services:\n  a:\n    build: ./a\n")
    with pytest.raises(ComposeError):
        compose.read_images("services:\n  a:\n    restart: always\n")


def test_expand():
    env = {"A": "a", "EMPTY": ""}
    assert expand("${A}/$A/x", env) == "a/a/x"
    assert expand("${MISSING:-d}|${EMPTY:-d}|${EMPTY-d}|${MISSING-d}", env) == "d|d||d"
    assert expand("${X:-${Y:-${A}/deep}}", env) == "a/deep"
    assert expand("${A:+set}|${MISSING:+set}", env) == "set|"
    assert expand("$$HOME $${A}", env) == "$HOME ${A}"
    assert expand("${A:?필수}", env) == "a"
    with pytest.raises(ComposeError):
        expand("${MISSING:?필수}", env)
    with pytest.raises(ComposeError):
        expand("${A", env)


@pytest.mark.parametrize(
    "text,repo,tag,digest",
    [
        ("postgres:16.16-alpine", "postgres", "16.16-alpine", None),
        ("postgres", "postgres", None, None),
        ("gitea/gitea@sha256:" + "a" * 64, "gitea/gitea", None, "sha256:" + "a" * 64),
        ("ghcr.io/o/n:1.0.0@sha256:" + "b" * 64, "ghcr.io/o/n", "1.0.0", "sha256:" + "b" * 64),
        ("localhost:5000/n", "localhost:5000/n", None, None),
        ("localhost:5000/n:tag", "localhost:5000/n", "tag", None),
    ],
)
def test_image_ref_parse(text, repo, tag, digest):
    ref = ImageRef.parse(text)
    assert (ref.repository, ref.tag, ref.digest) == (repo, tag, digest)
    assert str(ref) == text


@pytest.mark.parametrize("bad", ["", "a b", "x@sha256:short", "x@md5:" + "a" * 32, "x:", "${VAR}/x"])
def test_image_ref_rejects(bad):
    with pytest.raises(ComposeError):
        ImageRef.parse(bad)


# ── 구역별 남의 이미지, 다이제스트 없는 것 처리 ──────────────


def test_unpinned_third_party_fails_by_default(unpinned_images, zones_raw):
    with pytest.raises(ComposeError) as e:
        compose.third_party_by_zone(unpinned_images, json.loads(zones_raw))
    message = str(e.value)
    for needle in ("postgres:16.16-alpine", "redis:8.8.4-alpine", "nginx:1.31.8-alpine", "livekit/egress:v1.15.0"):
        assert needle in message


def test_unpinned_filled_from_pins(unpinned_images, zones_raw):
    out = compose.third_party_by_zone(unpinned_images, json.loads(zones_raw), pins=PINS)
    assert set(out) == {"core", "git", "meetings", "docs", "ai"}
    assert out["core"]["postgres"] == "postgres@" + PINS["postgres:16.16-alpine"]
    assert out["meetings"]["egress"] == "livekit/egress@" + PINS["livekit/egress:v1.15.0"]
    assert out["core"]["certbot"].startswith("certbot/certbot@sha256:")       # 이미 고정된 것은 그대로
    assert sum(len(m) for m in out.values()) == 9
    for refs in out.values():
        for ref in refs.values():
            assert "@sha256:" in ref and ":" not in ref.split("@")[0].rsplit("/", 1)[-1]


def test_unpinned_filled_by_resolver_only_for_missing(unpinned_images, zones_raw):
    asked = []

    def resolver(ref):
        asked.append(ref.by_tag())
        return fake_digest(ref.by_tag())

    out = compose.third_party_by_zone(unpinned_images, json.loads(zones_raw), pins={"redis:8.8.4-alpine": PINS["redis:8.8.4-alpine"]}, resolver=resolver)
    assert sorted(asked) == ["livekit/egress:v1.15.0", "nginx:1.31.8-alpine", "postgres:16.16-alpine"]
    assert out["core"]["redis"] == "redis@" + PINS["redis:8.8.4-alpine"]
    assert out["core"]["nginx"] == "nginx@" + fake_digest("nginx:1.31.8-alpine")


def test_partial_pins_still_fail_listing_the_rest(unpinned_images, zones_raw):
    with pytest.raises(ComposeError) as e:
        compose.third_party_by_zone(unpinned_images, json.loads(zones_raw), pins={"redis:8.8.4-alpine": PINS["redis:8.8.4-alpine"]})
    assert "redis" not in str(e.value) and "postgres" in str(e.value)


def test_bad_pin_value_rejected(unpinned_images, zones_raw):
    pins = dict(PINS, **{"redis:8.8.4-alpine": "latest"})
    with pytest.raises(ComposeError):
        compose.third_party_by_zone(unpinned_images, json.loads(zones_raw), pins=pins)


def test_repo_compose_fills_without_pins(images, zones_raw):
    out = compose.third_party_by_zone(images, json.loads(zones_raw))
    assert sum(len(m) for m in out.values()) == 9


def test_third_party_outside_any_zone_fails(unpinned_images, zones_raw):
    zones = json.loads(zones_raw)
    zones["core"]["services"].remove("redis")
    with pytest.raises(ComposeError) as e:
        compose.third_party_by_zone(unpinned_images, zones, pins=PINS)
    assert "redis" in str(e.value)


def test_service_zones_rejects_duplicates(zones_raw):
    zones = json.loads(zones_raw)
    zones["zones"][0]["services"].append("postgres")
    with pytest.raises(ComposeError):
        compose.service_zones(zones)


def test_registry_host_split():
    from jwrelease.registry import split_repository

    assert split_repository("postgres") == ("registry-1.docker.io", "library/postgres")
    assert split_repository("livekit/egress") == ("registry-1.docker.io", "livekit/egress")
    assert split_repository("docker.io/library/redis") == ("registry-1.docker.io", "library/redis")
    assert split_repository("ghcr.io/o/n") == ("ghcr.io", "o/n")
    assert split_repository("localhost:5000/n") == ("localhost:5000", "n")
