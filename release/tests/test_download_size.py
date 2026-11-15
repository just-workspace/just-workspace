"""받을 용량(`download_bytes`) — manifest 의 선택 항목, 레지스트리 조회, 명령 옵션. 네트워크 없이 돈다."""

import json
import urllib.error

import pytest

from jwrelease import builder, registry
from jwrelease.builder import BuildError
from jwrelease.cli import main
from jwrelease.compose import ComposeError, ImageRef
from jwrelease.model import FormatError, Manifest

from conftest import T0, digests_doc, fake_digest

OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"


def run(*argv):
    return main([str(a) for a in argv])


def image_doc(*layer_sizes, config=100):
    return {"schemaVersion": 2, "mediaType": OCI_MANIFEST, "config": {"size": config, "digest": fake_digest("c")},
            "layers": [{"size": n, "digest": fake_digest(f"l{n}")} for n in layer_sizes]}


class FakeRegistry:
    """주소 → manifest 문서. 부른 주소를 기억한다."""

    def __init__(self, docs: dict):
        self.docs = docs
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method: str, url: str):
        self.calls.append((method, url))
        if url not in self.docs:
            raise urllib.error.HTTPError(url, 404, "not found", None, None)
        doc = self.docs[url]
        return {"docker-content-digest": doc.get("_digest", "")}, json.dumps(doc).encode()


# ── manifest 의 선택 항목 ─────────────────────────────────────


def test_download_bytes_is_optional_and_absent_by_default(make_manifest):
    m = make_manifest()
    assert m.download_bytes is None
    assert "download_bytes" not in json.loads(m.to_bytes())          # 모르면 키를 싣지 않는다 — 옛 manifest 와 같은 바이트
    assert Manifest.from_bytes(m.to_bytes()) == m


def test_download_bytes_round_trip(make_manifest):
    m = make_manifest(download_bytes=1288490188)
    doc = json.loads(m.to_bytes())
    assert doc["download_bytes"] == 1288490188
    assert Manifest.from_bytes(m.to_bytes()).download_bytes == 1288490188
    assert make_manifest(download_bytes=0).download_bytes == 0


@pytest.mark.parametrize("bad", [-1, "10", 1.5, True, None])
def test_download_bytes_rejects_bad_values(make_manifest, bad):
    doc = json.loads(make_manifest().to_bytes())
    doc["download_bytes"] = bad
    with pytest.raises(FormatError):
        Manifest.from_dict(doc)
    if bad is not None:
        with pytest.raises(BuildError):
            make_manifest(download_bytes=bad)


def test_promotion_keeps_download_bytes(make_manifest):
    beta = make_manifest("1.1.0-beta.2", download_bytes=4242)
    assert builder.promote_manifest(beta, published=T0).download_bytes == 4242
    assert builder.promote_manifest(make_manifest("1.1.0-beta.2"), published=T0).download_bytes is None


# ── 레지스트리 조회 ───────────────────────────────────────────


@pytest.mark.parametrize("host,loopback", [
    ("localhost", True), ("localhost:5000", True), ("127.0.0.1:5000", True), ("127.0.0.1", True), ("127.8.9.1:5000", True),
    ("[::1]:5000", True), ("[::1]", True),
    ("ghcr.io", False), ("registry.example.com:5000", False), ("192.168.10.20:5000", False), ("localhost.example.com", False),
])
def test_loopback_registries_use_plain_http(host, loopback):
    assert registry.is_loopback_host(host) is loopback
    assert registry.base_url(host) == ("http://" if loopback else "https://") + host


def test_image_size_sums_config_and_layers():
    digest = fake_digest("img")
    reg = FakeRegistry({f"https://ghcr.io/v2/just-workspace/just-workspace-backend/manifests/{digest}": image_doc(1000, 2000, 30)})
    assert registry.image_size("ghcr.io/just-workspace/just-workspace-backend", digest, fetch=reg) == 3130
    assert reg.calls == [("GET", f"https://ghcr.io/v2/just-workspace/just-workspace-backend/manifests/{digest}")]


def test_image_size_follows_index_to_linux_amd64():
    index, arm, amd = fake_digest("index"), fake_digest("arm"), fake_digest("amd")
    base = "https://registry-1.docker.io/v2/library/postgres/manifests/"
    reg = FakeRegistry({
        base + index: {"mediaType": OCI_INDEX, "manifests": [
            {"digest": arm, "platform": {"os": "linux", "architecture": "arm64"}},
            {"digest": amd, "platform": {"os": "linux", "architecture": "amd64"}},
            {"digest": fake_digest("att"), "platform": {"os": "unknown", "architecture": "unknown"}}]},
        base + arm: image_doc(1),
        base + amd: image_doc(500, 700, config=50),
    })
    assert registry.image_size("postgres", index, fetch=reg) == 1250
    assert [url for _, url in reg.calls] == [base + index, base + amd]


def test_image_size_on_local_registry_uses_http():
    digest = fake_digest("local")
    reg = FakeRegistry({f"http://127.0.0.1:5000/v2/jw/just-workspace-backend/manifests/{digest}": image_doc(10, config=1)})
    assert registry.image_size("127.0.0.1:5000/jw/just-workspace-backend", digest, fetch=reg) == 11


def test_image_size_failures_are_reported():
    digest = fake_digest("x")
    url = f"https://ghcr.io/v2/a/b/manifests/{digest}"
    with pytest.raises(ComposeError, match="조회하지 못했다"):
        registry.image_size("ghcr.io/a/b", digest, fetch=FakeRegistry({}))
    only_arm = {"mediaType": OCI_INDEX, "manifests": [{"digest": fake_digest("arm"), "platform": {"os": "linux", "architecture": "arm64"}}]}
    with pytest.raises(ComposeError, match="linux/amd64"):
        registry.image_size("ghcr.io/a/b", digest, fetch=FakeRegistry({url: only_arm}))
    for broken in ({"layers": []}, {"config": {"size": 1}, "layers": [{"digest": "x"}]}, {"config": {}, "layers": [{"size": 5}]}):
        with pytest.raises(ComposeError, match="크기가 없다"):
            registry.image_size("ghcr.io/a/b", digest, fetch=FakeRegistry({url: broken}))


def test_resolve_digest_on_local_registry_uses_http():
    digest = fake_digest("tag")
    reg = FakeRegistry({"http://localhost:5000/v2/jw/nginx/manifests/1.31": {"_digest": digest}})
    assert registry.resolve_digest(ImageRef("localhost:5000/jw/nginx", "1.31", None), fetch=reg) == digest
    assert reg.calls == [("HEAD", "http://localhost:5000/v2/jw/nginx/manifests/1.31")]
    hub = FakeRegistry({"https://registry-1.docker.io/v2/library/nginx/manifests/1.31": {"_digest": digest}})
    assert registry.resolve_digest(ImageRef("nginx", "1.31", None), fetch=hub) == digest
    with pytest.raises(ComposeError):
        registry.resolve_digest(ImageRef("nginx", "9.9", None), fetch=hub)


def test_total_image_size_counts_every_image_once(make_manifest):
    m = make_manifest()
    seen = []

    def size_of(repo, digest):
        seen.append(f"{repo}@{digest}")
        return 10

    refs = set(m.all_image_refs().values())
    assert builder.total_image_size(m, size_of) == 10 * len(refs)
    assert sorted(seen) == sorted(refs)


# ── 명령 ─────────────────────────────────────────────────────


@pytest.fixture
def cli_args(tmp_path, settings):
    (tmp_path / "digests.json").write_text(json.dumps(digests_doc("1.0.0-beta.1", settings)), encoding="utf-8")
    return ["make-manifest", "--version", "1.0.0-beta.1", "--digests", tmp_path / "digests.json",
            "-o", tmp_path / "manifest.json", "--now", "2026-12-01T09:00:00Z"]


def read(tmp_path) -> Manifest:
    return Manifest.from_bytes((tmp_path / "manifest.json").read_bytes())


def test_cli_download_bytes_and_db_schema(tmp_path, cli_args, capsys):
    assert run(*cli_args) == 0
    plain = read(tmp_path)
    assert plain.download_bytes is None and plain.db_schema is None
    assert run(*cli_args, "--download-bytes", 123456, "--db-schema", 7) == 0
    m = read(tmp_path)
    assert m.download_bytes == 123456 and m.db_schema == 7
    assert "123456" in capsys.readouterr().out
    assert run(*cli_args, "--download-bytes", -5) == 2
    assert run(*cli_args, "--download-bytes", 1, "--resolve-sizes") == 2


def test_cli_resolve_sizes_fills_total(tmp_path, cli_args, monkeypatch):
    monkeypatch.setattr(registry, "image_size", lambda repo, digest: 1000)
    assert run(*cli_args, "--resolve-sizes") == 0
    m = read(tmp_path)
    assert m.download_bytes == 1000 * len(set(m.all_image_refs().values()))


def test_cli_resolve_sizes_failure_only_warns(tmp_path, cli_args, monkeypatch, capsys):
    def boom(repo, digest):
        raise ComposeError(f"{repo}: 크기를 조회하지 못했다(연결 실패)")

    monkeypatch.setattr(registry, "image_size", boom)
    assert run(*cli_args, "--resolve-sizes") == 0                  # 실패해도 manifest 는 만든다
    assert read(tmp_path).download_bytes is None
    assert "download_bytes" not in json.loads((tmp_path / "manifest.json").read_bytes())
    assert "경고" in capsys.readouterr().err
