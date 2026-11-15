"""JSON Schema ↔ 예시 파일 ↔ 파이썬 모델이 서로 같은 형식을 말하는지."""

import json

import pytest

from jwrelease import builder
from jwrelease.config import Settings, load_settings
from jwrelease.model import Channel, Manifest, ReleaseEntry, canonical_bytes, new_channel, sha256_hex

from conftest import RELEASE_DIR, T0

jsonschema = pytest.importorskip("jsonschema")

SCHEMA_DIR = RELEASE_DIR / "schema"
EXAMPLES = RELEASE_DIR / "examples"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def channel_validator():
    schema = load(SCHEMA_DIR / "channel.schema.json")
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator(schema)


@pytest.fixture(scope="module")
def manifest_validator():
    schema = load(SCHEMA_DIR / "manifest.schema.json")
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator(schema)


@pytest.mark.parametrize("name", ["channel-stable.json", "channel-beta.json"])
def test_channel_examples_match_schema_and_model(channel_validator, name):
    doc = load(EXAMPLES / name)
    channel_validator.validate(doc)
    assert Channel.from_dict(doc).to_dict() == doc


@pytest.mark.parametrize("name", ["manifest-1.0.0-beta.1.json", "manifest-1.0.0.json"])
def test_manifest_examples_match_schema_and_model(manifest_validator, name):
    doc = load(EXAMPLES / name)
    manifest_validator.validate(doc)
    assert Manifest.from_dict(doc).to_dict() == doc


def test_examples_are_consistent_with_each_other():
    """채널 예시의 해시는 manifest 예시를 결정적 직렬화한 바이트의 것이고, 승격 예시는 다이제스트가 같다."""
    beta_m = Manifest.from_dict(load(EXAMPLES / "manifest-1.0.0-beta.1.json"))
    stable_m = Manifest.from_dict(load(EXAMPLES / "manifest-1.0.0.json"))
    beta_c = Channel.from_dict(load(EXAMPLES / "channel-beta.json"))
    stable_c = Channel.from_dict(load(EXAMPLES / "channel-stable.json"))
    assert beta_c.find("1.0.0-beta.1").manifest_sha256 == sha256_hex(beta_m.to_bytes())
    assert stable_c.find("1.0.0").manifest_sha256 == sha256_hex(stable_m.to_bytes())
    assert beta_c.find("1.0.0") == stable_c.find("1.0.0")
    assert stable_m.promoted_from == "1.0.0-beta.1" and stable_m.images == beta_m.images
    assert stable_m.third_party == beta_m.third_party


def test_other_examples_load():
    digests = builder.Digests.from_bytes((EXAMPLES / "digests.json").read_bytes())
    assert digests.version == "1.0.0-beta.1" and "backend" in digests.images
    assert load_settings(EXAMPLES / "settings.json") == Settings()        # 예시 설정 = 기본값
    pins = load(EXAMPLES / "pins.json")
    assert all(v.startswith("sha256:") and len(v) == 71 for v in pins.values())


def test_generated_files_match_schema(channel_validator, manifest_validator, make_manifest):
    """도구가 실제로 만드는 바이트가 스키마를 지킨다(예시뿐 아니라)."""
    beta = make_manifest("1.1.0-beta.2", min_upgrade_from="1.0.0", changelog="변경")
    stable = builder.promote_manifest(beta, published=T0)
    for m in (beta, stable):
        manifest_validator.validate(json.loads(m.to_bytes()))
    ch = new_channel("beta")
    for m in (beta, stable):
        ch = ch.with_release(ReleaseEntry(m.version, m.published, f"releases/{m.version}/manifest.json", sha256_hex(m.to_bytes()), m.min_upgrade_from, "요약"))
    channel_validator.validate(json.loads(ch.bumped(T0, 30).to_bytes()))


def _mutations(doc, changes):
    for change in changes:
        bad = json.loads(json.dumps(doc))
        change(bad)
        yield bad


def test_schema_and_model_reject_the_same_bad_channels(channel_validator):
    doc = load(EXAMPLES / "channel-stable.json")
    changes = [
        lambda d: d.update(format=2),
        lambda d: d.update(channel="nightly"),
        lambda d: d.update(sequence=0),
        lambda d: d.update(sequence="1"),
        lambda d: d.update(expires="2027-01-14"),
        lambda d: d.pop("expires"),
        lambda d: d.update(extra=True),
        lambda d: d["releases"][0].update(version="1.0.0-beta.1"),        # stable 채널에 Beta
        lambda d: d["releases"][0].update(version="1.0"),
        lambda d: d["releases"][0].pop("min_upgrade_from"),
        lambda d: d["releases"][0].update(min_upgrade_from="old"),
        lambda d: d["releases"][0]["manifest"].update(sha256="xyz"),
        lambda d: d["releases"][0]["manifest"].update(path="/abs/manifest.json"),
        lambda d: d["releases"][0].update(summary="두\n줄"),
    ]
    for bad in _mutations(doc, changes):
        assert not channel_validator.is_valid(bad), bad
        with pytest.raises(Exception):
            Channel.from_dict(bad)


def test_schema_and_model_reject_the_same_bad_manifests(manifest_validator):
    doc = load(EXAMPLES / "manifest-1.0.0-beta.1.json")
    changes = [
        lambda d: d.update(format=0),
        lambda d: d.update(version="1.0.0-rc.1"),
        lambda d: d.update(published="yesterday"),
        lambda d: d.update(images={}),
        lambda d: d["images"].update(backend="ghcr.io/just-workspace/just-workspace-backend:1.0.0"),
        lambda d: d["third_party"]["core"].update(postgres="postgres:16.16-alpine"),
        lambda d: d["zones"].update(sha256="nope"),
        lambda d: d["zones"].pop("content"),
        lambda d: d.update(apps=[{"kind": "macos", "filename": "a.dmg", "size": 1, "sha256": "0" * 64, "url": "https://x/a"}]),
        lambda d: d["apps"][0].update(size=-1),
        lambda d: d["apps"][0].update(filename="dir/app.exe"),
        lambda d: d.update(offline_bundle={"url": "https://x/b.tar", "size": 1}),
        lambda d: d.update(installer_bundle="bundle.tar"),
        lambda d: d.update(changelog=None),
        lambda d: d.update(plugin_api="1"),
        lambda d: d.update(db_schema=[1]),
        lambda d: d.pop("promoted_from"),
        lambda d: d.update(surprise=1),
        lambda d: d.update(download_bytes=-1),
        lambda d: d.update(download_bytes="1288490188"),
        lambda d: d.update(download_bytes=None),                          # 모르면 null 이 아니라 키를 뺀다
    ]
    for bad in _mutations(doc, changes):
        assert not manifest_validator.is_valid(bad), bad
        with pytest.raises(Exception):
            Manifest.from_dict(bad)


def test_examples_serialize_deterministically():
    for name in ("channel-stable.json", "channel-beta.json", "manifest-1.0.0.json"):
        doc = load(EXAMPLES / name)
        assert canonical_bytes(doc) == canonical_bytes(json.loads(json.dumps(doc, indent=4)))
