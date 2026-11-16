import json
import re
from datetime import timedelta

import pytest

from jwrelease import builder
from jwrelease.builder import BuildError
from jwrelease.config import Settings, load_settings
from jwrelease.model import FileRef, Manifest, sha256_hex, zones_fingerprint

from conftest import OWN, PINS, T0, digests_doc, fake_digest, make_digests


def test_manifest_contents(make_manifest, settings, zones_raw):
    m = make_manifest("1.0.0-beta.1", min_upgrade_from=None, changelog="## 변경\n- 하나\n")
    assert m.version == "1.0.0-beta.1" and m.published == "2026-12-01T09:00:00Z"
    assert set(m.images) == set(OWN) | {"installer"}
    for name, ref in m.images.items():
        assert ref == f"ghcr.io/just-workspace/just-workspace-{name}@{fake_digest('img:' + name)}"
    assert set(m.third_party) == {"core", "git", "meetings", "docs", "ai"}
    assert re.fullmatch(r"postgres@sha256:[0-9a-f]{64}", m.third_party["core"]["postgres"])   # compose 에 고정된 값 그대로 유지
    assert m.third_party["core"]["postgres"] != "postgres@" + PINS["postgres:16.16-alpine"]   # pins 는 미고정 항목만 보완한다
    assert (m.zones_sha256, m.zones_content) == zones_fingerprint(zones_raw)
    assert m.zones_content == json.loads(zones_raw)
    # 예약만 된 항목(값 없음)
    assert m.db_schema is None and m.plugin_api is None and m.installer_bundle is None
    assert m.offline_bundle is None and m.apps == () and m.promoted_from is None
    Manifest.from_bytes(m.to_bytes())


def test_same_inputs_same_bytes(make_manifest):
    assert make_manifest().to_bytes() == make_manifest().to_bytes()
    assert sha256_hex(make_manifest().to_bytes()) != sha256_hex(make_manifest(changelog="x").to_bytes())


def test_repo_compose_needs_no_pins(make_manifest):
    """리포의 compose 는 외부 이미지를 전부 다이제스트로 고정하므로 pins 없이도 manifest 가 생성된다."""
    m = make_manifest(pins=None)
    assert all("@sha256:" in ref for refs in m.third_party.values() for ref in refs.values())


def test_unpinned_third_party_fails_without_pins(make_manifest, unpinned_compose_text):
    with pytest.raises(BuildError) as e:
        make_manifest(pins=None, compose_text=unpinned_compose_text)
    assert "postgres:16.16-alpine" in str(e.value)


def test_unpinned_third_party_filled_from_pins(make_manifest, unpinned_compose_text):
    m = make_manifest(compose_text=unpinned_compose_text)
    assert m.third_party["core"]["postgres"] == "postgres@" + PINS["postgres:16.16-alpine"]


def test_unpinned_third_party_filled_by_resolver(make_manifest, unpinned_compose_text):
    m = make_manifest(pins=None, compose_text=unpinned_compose_text, resolver=lambda ref: fake_digest("r:" + ref.by_tag()))
    assert m.third_party["core"]["nginx"] == "nginx@" + fake_digest("r:nginx:1.31.8-alpine")


def test_version_must_match_digests(compose_text, zones_raw, settings):
    with pytest.raises(BuildError):
        builder.make_manifest(
            version="1.0.1", digests=make_digests("1.0.0", settings), compose_text=compose_text,
            zones_raw=zones_raw, settings=settings, published=T0, pins=PINS,
        )


@pytest.mark.parametrize("bad", ["1.0", "v1.0.0", "1.0.0-rc.1", "1.0.0-beta.0", "latest"])
def test_bad_version_rejected(make_manifest, bad):
    with pytest.raises(BuildError):
        make_manifest(bad)


def test_missing_build_result_fails(compose_text, zones_raw, settings):
    names = [n for n in OWN if n != "sso"]
    with pytest.raises(BuildError) as e:
        builder.make_manifest(
            version="1.0.0", digests=make_digests("1.0.0", settings, names), compose_text=compose_text,
            zones_raw=zones_raw, settings=settings, published=T0, pins=PINS,
        )
    assert "sso" in str(e.value)


def test_repository_mismatch_fails(compose_text, zones_raw, settings):
    doc = digests_doc("1.0.0", settings)
    doc["images"]["backend"]["repository"] = "ghcr.io/someone-else/just-workspace-backend"
    with pytest.raises(BuildError) as e:
        builder.make_manifest(
            version="1.0.0", digests=builder.Digests.from_bytes(json.dumps(doc).encode()), compose_text=compose_text,
            zones_raw=zones_raw, settings=settings, published=T0, pins=PINS,
        )
    assert "backend" in str(e.value)
    doc = digests_doc("1.0.0", settings)
    doc["images"]["installer"]["repository"] = "ghcr.io/just-workspace/other"
    with pytest.raises(BuildError):
        builder.make_manifest(
            version="1.0.0", digests=builder.Digests.from_bytes(json.dumps(doc).encode()), compose_text=compose_text,
            zones_raw=zones_raw, settings=settings, published=T0, pins=PINS,
        )


def test_registry_is_a_setting(compose_text, zones_raw):
    moved = load_settings(env={"JWRELEASE_REGISTRY": "registry.example.com/team", "JWRELEASE_IMAGE_PREFIX": "just-workspace-"})
    m = builder.make_manifest(
        version="1.0.0", digests=make_digests("1.0.0", moved), compose_text=compose_text,
        zones_raw=zones_raw, settings=moved, published=T0, pins=PINS,
    )
    assert m.images["backend"].startswith("registry.example.com/team/just-workspace-backend@sha256:")


def test_min_upgrade_from_checked(make_manifest):
    assert make_manifest("1.2.0", min_upgrade_from="1.1.0").min_upgrade_from == "1.1.0"
    with pytest.raises(BuildError):
        make_manifest("1.2.0", min_upgrade_from="1.3.0")
    with pytest.raises(BuildError):
        make_manifest("1.2.0", min_upgrade_from="1.1")


@pytest.mark.parametrize(
    "change",
    [
        {"format": 2},
        {"version": ""},
        {"images": {}},
        {"images": {"backend": {"repository": "ghcr.io/x/y:tag", "digest": "sha256:" + "a" * 64}}},
        {"images": {"backend": {"repository": "ghcr.io/x/y", "digest": "sha256:xyz"}}},
        {"images": {"backend": "ghcr.io/x/y@sha256:" + "a" * 64}},
    ],
)
def test_digests_file_validated(settings, change):
    doc = digests_doc("1.0.0", settings)
    doc.update(change)
    with pytest.raises(BuildError):
        builder.Digests.from_bytes(json.dumps(doc).encode())


def test_collect_apps(tmp_path, settings):
    (tmp_path / "workspace-desktop-setup.exe").write_bytes(b"exe-bytes")
    (tmp_path / "workspace-android.apk").write_bytes(b"apk-bytes!")
    (tmp_path / "notes.txt").write_bytes(b"ignored")
    apps = builder.collect_apps(tmp_path, "1.0.0", settings)
    assert [(a.kind, a.filename, a.size) for a in apps] == [
        ("android", "workspace-android.apk", 10),
        ("windows-desktop", "workspace-desktop-setup.exe", 9),
    ]
    assert apps[0].sha256 == sha256_hex(b"apk-bytes!")
    assert apps[1].url == "https://github.com/just-workspace/just-workspace/releases/download/v1.0.0/workspace-desktop-setup.exe"
    (tmp_path / "second.exe").write_bytes(b"x")
    with pytest.raises(BuildError):
        builder.collect_apps(tmp_path, "1.0.0", settings)


def test_settings_defaults_and_overrides(tmp_path):
    s = Settings()
    assert s.registry == "ghcr.io/just-workspace" and s.expires_days == 90
    assert s.image_repository("backend") == "ghcr.io/just-workspace/just-workspace-backend"
    assert s.channel_url("channels/stable.json") == "https://raw.githubusercontent.com/just-workspace/releases/main/channels/stable.json"

    cfg = tmp_path / "settings.json"
    cfg.write_text(json.dumps({"registry": "r.example/ns", "expires_days": 14, "download_url_template": "https://dl.example/{version}/{filename}"}), encoding="utf-8")
    s = load_settings(cfg, {"JWRELEASE_EXPIRES_DAYS": "7"})
    assert s.registry == "r.example/ns" and s.expires_days == 7            # 환경변수 > 파일 > 기본값
    assert s.download_url("1.0.0", "a.exe") == "https://dl.example/1.0.0/a.exe"
    cfg.write_text(json.dumps({"nope": 1}), encoding="utf-8")
    with pytest.raises(ValueError):
        load_settings(cfg)
    with pytest.raises(ValueError):
        load_settings(env={"JWRELEASE_EXPIRES_DAYS": "0"})


def test_summary_line():
    assert builder.summary_line("\n## 1.0.0 — 첫 정식판\n\n- 항목\n") == "1.0.0 — 첫 정식판"
    assert builder.summary_line("") == ""


# ── 승격 ─────────────────────────────────────────────────────


def test_promote_keeps_digests_and_changes_only_version_fields(make_manifest):
    beta = make_manifest("1.2.0-beta.3", min_upgrade_from="1.1.0", changelog="베타 변경")
    stable = builder.promote_manifest(beta, published=T0 + timedelta(days=14))

    assert stable.version == "1.2.0" and stable.promoted_from == "1.2.0-beta.3"
    assert stable.images == beta.images                      # 다이제스트 완전 동일(변경 없음)
    assert stable.third_party == beta.third_party
    assert (stable.zones_sha256, stable.zones_content) == (beta.zones_sha256, beta.zones_content)

    a, b = beta.to_dict(), stable.to_dict()
    changed = {k for k in a if a[k] != b[k]}
    assert changed == {"version", "published", "promoted_from"}
    assert stable.min_upgrade_from == "1.1.0" and stable.changelog == "베타 변경"
    Manifest.from_bytes(stable.to_bytes())


def test_promote_overrides(make_manifest):
    beta = make_manifest("1.2.0-beta.3", min_upgrade_from="1.2.0-beta.1")
    assert builder.promote_manifest(beta, published=T0, min_upgrade_from=None).min_upgrade_from is None
    assert builder.promote_manifest(beta, published=T0, min_upgrade_from="1.1.0").min_upgrade_from == "1.1.0"
    assert builder.promote_manifest(beta, published=T0, changelog="정식판").changelog == "정식판"
    with pytest.raises(BuildError):
        builder.promote_manifest(beta, published=T0, min_upgrade_from="1.3.0")


def test_promote_drops_offline_bundle_and_keeps_apps(make_manifest, tmp_path, settings):
    (tmp_path / "workspace-desktop-setup.exe").write_bytes(b"exe")
    beta = make_manifest(
        "1.0.0-beta.1",
        apps=builder.collect_apps(tmp_path, "1.0.0-beta.1", settings),
        offline_bundle=FileRef("https://example.com/b.tar", 10, "0" * 64),
    )
    stable = builder.promote_manifest(beta, published=T0)
    assert stable.offline_bundle is None and stable.apps == beta.apps


def test_promote_refuses_stable(make_manifest):
    with pytest.raises(BuildError):
        builder.promote_manifest(make_manifest("1.0.0"), published=T0)


def test_retag_commands_point_at_same_digest(make_manifest):
    beta = make_manifest("1.2.0-beta.3")
    stable = builder.promote_manifest(beta, published=T0)
    cmds = builder.retag_commands(stable, stable.version)
    assert len(cmds) == len(beta.images)
    by_source = {c[-1]: c for c in cmds}
    for name, ref in beta.images.items():
        cmd = by_source[ref]                                  # 원본은 Beta 시점의 다이제스트와 동일
        repo = ref.split("@")[0]
        assert cmd == ["docker", "buildx", "imagetools", "create", "--tag", f"{repo}:1.2.0", ref]
    assert not any("build" == c[1] and "imagetools" != c[2] for c in cmds)
