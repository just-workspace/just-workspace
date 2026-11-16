import io
import json
import tarfile

import pytest

from jwrelease import bundle, sign
from jwrelease.bundle import BundleError
from jwrelease.cli import main
from jwrelease.model import FileRef, canonical_bytes, sha256_hex

from conftest import T0


def stage_dir(tmp_path, manifest, key, include_third_party=False):
    """docker save 대신 가짜 이미지 파일을 배치한 준비 디렉터리."""
    stage = tmp_path / "stage"
    (stage / "images").mkdir(parents=True)
    (stage / "manifest.json").write_bytes(manifest.to_bytes())
    sign.sign_file(stage / "manifest.json", key.private)
    for name, item in bundle.image_tags(manifest, include_third_party).items():
        (stage / item["file"]).write_bytes(f"fake docker save of {name}\n".encode() * 50)
    return stage


def build(tmp_path, manifest, key, include_third_party=False):
    stage = stage_dir(tmp_path, manifest, key, include_third_party)
    bundle.write_index(stage, T0, include_third_party)
    sign.sign_file(stage / "bundle.json", key.private)
    out = tmp_path / bundle.bundle_filename(manifest.version)
    bundle.pack(stage, out)
    return stage, out


def rewrite(src, dst, change):
    """번들을 해제하여 `change(이름 → 바이트)` 를 적용한 후 재번들링한다(공격자 모사)."""
    with tarfile.open(src) as tar:
        files = {m.name: tar.extractfile(m).read() for m in tar}
    change(files)
    with tarfile.open(dst, "w") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return dst


def test_save_commands(make_manifest):
    m = make_manifest("1.0.0")
    cmds = bundle.save_commands(m, "stage")
    assert len(cmds) == 3 * len(m.images)
    ref = m.images["backend"]
    tag = "ghcr.io/just-workspace/just-workspace-backend:1.0.0"
    i = cmds.index(["docker", "pull", ref])
    assert cmds[i : i + 3] == [
        ["docker", "pull", ref],
        ["docker", "tag", ref, tag],
        ["docker", "save", "--output", "stage/images/backend.tar", tag],
    ]
    assert all(c[0] == "docker" and c[1] in ("pull", "tag", "save") for c in cmds)


def test_save_commands_with_third_party(make_manifest):
    m = make_manifest("1.0.0")
    tags = bundle.image_tags(m, include_third_party=True)
    assert len(tags) == len(m.images) + 9
    digest = m.third_party["core"]["postgres"].split("@sha256:")[1]
    assert tags["postgres"] == {
        "ref": m.third_party["core"]["postgres"],
        "tag": f"postgres:jw-{digest[:12]}",
        "file": "images/postgres.tar",
    }


def test_bundle_structure(tmp_path, key, make_manifest):
    m = make_manifest("1.0.0")
    stage, out = build(tmp_path, m, key)
    assert out.name == "just-workspace-1.0.0-offline.tar"
    with tarfile.open(out) as tar:
        names = tar.getnames()
        members = tar.getmembers()
    expected_images = sorted(f"images/{n}.tar" for n in m.images)
    # 색인과 그 서명이 최선두, 이후는 색인의 파일 목록 순서(경로 오름차순)
    assert names == ["bundle.json", "bundle.json.sig"] + expected_images + ["manifest.json", "manifest.json.sig"]
    assert all(mb.isreg() and mb.uid == 0 and mb.gid == 0 and mb.mtime == int(T0.timestamp()) for mb in members)

    index = json.loads((stage / "bundle.json").read_bytes())
    assert (stage / "bundle.json").read_bytes() == canonical_bytes(index)
    assert set(index) == {"format", "version", "created", "files", "images"}
    assert index["version"] == "1.0.0" and index["format"] == 1
    assert [f["path"] for f in index["files"]] == expected_images + ["manifest.json", "manifest.json.sig"]
    for f in index["files"]:
        data = (stage / f["path"]).read_bytes()
        assert (f["size"], f["sha256"]) == (len(data), sha256_hex(data))
    assert index["images"]["backend"]["tag"] == "ghcr.io/just-workspace/just-workspace-backend:1.0.0"


def test_pack_is_reproducible(tmp_path, key, make_manifest):
    stage, out = build(tmp_path, make_manifest("1.0.0"), key)
    again = tmp_path / "again.tar"
    bundle.pack(stage, again)
    assert out.read_bytes() == again.read_bytes()


def test_bundle_verifies(tmp_path, key, other_key, make_manifest):
    m = make_manifest("1.0.0")
    _, out = build(tmp_path, m, key)
    info = bundle.verify_bundle(out, [key.public])
    assert info.version == "1.0.0" and info.manifest == m and set(info.images) == set(m.images)
    assert bundle.verify_bundle(out, [other_key.public, key.public]).version == "1.0.0"
    with pytest.raises(BundleError) as e:
        bundle.verify_bundle(out, [other_key.public])
    assert "묶음 서명" in str(e.value)


def test_bundle_with_third_party_verifies(tmp_path, key, make_manifest):
    m = make_manifest("1.0.0")
    _, out = build(tmp_path, m, key, include_third_party=True)
    assert len(bundle.verify_bundle(out, [key.public]).images) == len(m.images) + 9


def test_verification_order_and_tamper_detection(tmp_path, key, other_key, make_manifest):
    m = make_manifest("1.0.0")
    _, out = build(tmp_path, m, key)

    def expect(change, needle):
        with pytest.raises(BundleError) as e:
            bundle.verify_bundle(rewrite(out, tmp_path / "bad.tar", change), [key.public])
        assert needle in str(e.value), str(e.value)

    # 1단계: 색인 변경 시 번들 서명 검증에서 실패(이미지를 읽기 전)
    def edit_index(files):
        files["bundle.json"] = files["bundle.json"].replace(b'"version":"1.0.0"', b'"version":"9.9.9"')
        files["images/backend.tar"] = b"changed too"

    expect(edit_index, "묶음 서명")

    # 2단계: manifest 변경 시 색인의 해시와 불일치하여 manifest 단계에서 실패
    def edit_manifest(files):
        files["manifest.json"] = files["manifest.json"].replace(b'"version":"1.0.0"', b'"version":"1.0.1"')

    expect(edit_manifest, "manifest")

    # 3단계: 이미지 파일 변조·누락·삽입
    expect(lambda f: f.update({"images/backend.tar": f["images/backend.tar"] + b"x"}), "images/backend.tar")
    expect(lambda f: f.pop("images/sso.tar"), "images/sso.tar")
    expect(lambda f: f.update({"images/evil.tar": b"x"}), "색인에 없는 파일")
    expect(lambda f: f.pop("bundle.json.sig"), "bundle.json.sig")

    # 색인 전체를 재생성하여 다른 키로 서명해도 통과 불가
    def resign(files):
        files["images/backend.tar"] = b"malicious"
        index = json.loads(files["bundle.json"])
        for item in index["files"]:
            if item["path"] == "images/backend.tar":
                item["size"], item["sha256"] = 9, sha256_hex(b"malicious")
        files["bundle.json"] = canonical_bytes(index)
        files["bundle.json.sig"] = sign.sign_bytes(files["bundle.json"], other_key.private)

    expect(resign, "묶음 서명")


def test_manifest_inside_bundle_needs_its_own_valid_signature(tmp_path, key, other_key, make_manifest):
    """색인이 올바른 키로 서명되었더라도 manifest 서명이 불일치하면 거부."""
    m = make_manifest("1.0.0")
    stage = stage_dir(tmp_path, m, key)
    sign.sign_file(stage / "manifest.json", other_key.private)
    bundle.write_index(stage, T0)
    sign.sign_file(stage / "bundle.json", key.private)
    out = tmp_path / "b.tar"
    bundle.pack(stage, out)
    with pytest.raises(BundleError) as e:
        bundle.verify_bundle(out, [key.public])
    assert "manifest" in str(e.value)


def test_index_refuses_incomplete_stage(tmp_path, key, make_manifest):
    m = make_manifest("1.0.0")
    stage = stage_dir(tmp_path, m, key)
    (stage / "images/ldap.tar").unlink()
    with pytest.raises(BundleError) as e:
        bundle.write_index(stage, T0)
    assert "images/ldap.tar" in str(e.value)
    with pytest.raises(BundleError):                       # 색인·서명 없이 번들링
        bundle.pack(stage, tmp_path / "x.tar")


def test_manifest_with_offline_bundle_field_cannot_go_inside(tmp_path, key, make_manifest):
    m = make_manifest("1.0.0", offline_bundle=FileRef("https://example.com/b.tar", 1, "0" * 64))
    stage = stage_dir(tmp_path, m, key)
    with pytest.raises(BundleError):
        bundle.write_index(stage, T0)


def test_unsafe_archives_rejected(tmp_path, key, make_manifest):
    _, out = build(tmp_path, make_manifest("1.0.0"), key)
    bad = tmp_path / "link.tar"
    with tarfile.open(out) as src, tarfile.open(bad, "w") as dst:
        for mb in src:
            dst.addfile(mb, src.extractfile(mb))
        link = tarfile.TarInfo("images/link.tar")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        dst.addfile(link)
    with pytest.raises(BundleError):
        bundle.verify_bundle(bad, [key.public])
    (tmp_path / "junk.tar").write_bytes(b"not a tar")
    with pytest.raises(BundleError):
        bundle.verify_bundle(tmp_path / "junk.tar", [key.public])


def test_cli_bundle_flow(tmp_path, key, make_manifest, capsys):
    priv, pub = key.write(tmp_path)
    m = make_manifest("1.0.0")
    stage = stage_dir(tmp_path, m, key)
    run = lambda *a: main([str(x) for x in a])  # noqa: E731

    assert run("bundle", "plan", "--manifest", stage / "manifest.json", "--stage", stage) == 0
    out = capsys.readouterr().out
    assert out.count("docker save --output") == len(m.images) and "docker pull" in out

    assert run("bundle", "index", "--stage", stage, "--key", priv, "--now", "2026-12-01T09:00:00Z") == 0
    target = tmp_path / "out.tar"
    assert run("bundle", "pack", "--stage", stage, "-o", target) == 0
    assert run("bundle", "verify", target, "--pubkey", pub) == 0
    capsys.readouterr()
