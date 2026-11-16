import json
from datetime import timedelta

import pytest

from jwrelease import builder, channelrepo, sign, verify
from jwrelease.channelrepo import RepoError
from jwrelease.cli import main
from jwrelease.model import Channel, Manifest, format_time, sha256_hex

from conftest import PINS, T0, digests_doc


def publish(repo, manifest, channel, key, now=T0, **kw):
    return channelrepo.publish(repo, manifest.to_bytes(), channel, key=key.private, now=now, expires_days=30, **kw)


def check(repo, key, now=T0, **kw):
    return channelrepo.verify_all(channelrepo.dir_fetch(repo), [key.public], now=now, **kw)


def test_publish_beta_then_verify(tmp_path, key, make_manifest):
    m = make_manifest("1.0.0-beta.1")
    result = publish(tmp_path, m, "beta", key, summary="첫 시험판")
    assert sorted(result.written) == [
        "channels/beta.json", "channels/beta.json.sig",
        "releases/1.0.0-beta.1/manifest.json", "releases/1.0.0-beta.1/manifest.json.sig",
    ]
    assert not result.unsigned and not (tmp_path / "channels/stable.json").exists()
    ch = channelrepo.load_channel(tmp_path, "beta")
    assert ch.sequence == 1 and ch.generated == format_time(T0) and ch.expires == format_time(T0 + timedelta(days=30))
    e = ch.releases[0]
    assert (e.version, e.summary, e.manifest_path) == ("1.0.0-beta.1", "첫 시험판", "releases/1.0.0-beta.1/manifest.json")
    assert e.manifest_sha256 == sha256_hex((tmp_path / e.manifest_path).read_bytes())
    # 파일은 결정적 직렬화 결과와 동일(LF, 끝 줄바꿈 하나)
    raw = (tmp_path / "channels/beta.json").read_bytes()
    assert raw == ch.to_bytes() and b"\r" not in raw

    report = check(tmp_path, key, channels=("beta",))
    assert report.passed and len(report.ok) == 2


def test_stable_release_also_lands_in_beta(tmp_path, key, make_manifest):
    publish(tmp_path, make_manifest("1.0.0-beta.1"), "beta", key)
    publish(tmp_path, make_manifest("1.0.0"), "stable", key, now=T0 + timedelta(days=1))
    stable, beta = channelrepo.load_channel(tmp_path, "stable"), channelrepo.load_channel(tmp_path, "beta")
    assert [r.version for r in stable.releases] == ["1.0.0"]
    assert [r.version for r in beta.releases] == ["1.0.0-beta.1", "1.0.0"]
    assert stable.sequence == 1 and beta.sequence == 2
    assert beta.find("1.0.0") == stable.find("1.0.0")
    assert check(tmp_path, key, now=T0 + timedelta(days=2)).passed


def test_sequence_only_goes_up(tmp_path, key, make_manifest):
    seqs = []
    for i, v in enumerate(["1.0.0-beta.1", "1.0.0-beta.2", "1.0.0-beta.3"]):
        publish(tmp_path, make_manifest(v), "beta", key, now=T0 + timedelta(days=i))
        seqs.append(channelrepo.load_channel(tmp_path, "beta").sequence)
    channelrepo.refresh(tmp_path, ("beta",), key=key.private, now=T0 + timedelta(days=5), expires_days=30)
    seqs.append(channelrepo.load_channel(tmp_path, "beta").sequence)
    assert seqs == [1, 2, 3, 4]


def test_channel_rules_enforced(tmp_path, key, make_manifest):
    with pytest.raises(RepoError):
        publish(tmp_path, make_manifest("1.0.0-beta.1"), "stable", key)      # stable 에 Beta
    with pytest.raises(RepoError):
        publish(tmp_path, make_manifest("1.0.0"), "beta", key)               # Stable 은 stable 로 게시
    publish(tmp_path, make_manifest("1.0.0-beta.1"), "beta", key)
    with pytest.raises(RepoError):
        publish(tmp_path, make_manifest("1.0.0-beta.1"), "beta", key)        # 동일 버전 재게시
    with pytest.raises(RepoError):                                           # 게시된 릴리스의 내용 변경
        publish(tmp_path, make_manifest("1.0.0-beta.1", changelog="바뀜"), "beta", key)
    assert channelrepo.load_channel(tmp_path, "beta").sequence == 1          # 실패 시 아무것도 기록하지 않는다
    assert not list(tmp_path.glob("channels/stable*"))


def test_refresh_extends_expiry_without_changing_releases(tmp_path, key, make_manifest):
    publish(tmp_path, make_manifest("1.0.0"), "stable", key)
    before = {n: channelrepo.load_channel(tmp_path, n) for n in ("stable", "beta")}
    later = T0 + timedelta(days=20)
    result = channelrepo.refresh(tmp_path, ("stable", "beta"), key=key.private, now=later, expires_days=30)
    assert sorted(result.written) == ["channels/beta.json", "channels/beta.json.sig", "channels/stable.json", "channels/stable.json.sig"]
    for name in ("stable", "beta"):
        after = channelrepo.load_channel(tmp_path, name)
        assert after.sequence == before[name].sequence + 1
        assert after.releases == before[name].releases
        assert after.expires == format_time(later + timedelta(days=30))
    # 원래 만료(30일) 경과 시점에도 통과
    assert check(tmp_path, key, now=T0 + timedelta(days=45)).passed
    with pytest.raises(RepoError):
        channelrepo.refresh(tmp_path / "empty", ("stable",), key=key.private, now=later, expires_days=30)


def test_verify_all_reports_each_failure(tmp_path, key, other_key, make_manifest):
    publish(tmp_path, make_manifest("1.0.0-beta.1"), "beta", key)
    publish(tmp_path, make_manifest("1.0.0"), "stable", key)
    assert check(tmp_path, key).passed

    assert not check(tmp_path, other_key).passed                                     # 다른 키
    assert check(tmp_path, key, now=T0 + timedelta(days=31)).errors                  # 만료
    report = check(tmp_path, key, last_sequences={"beta": 5})                        # 순번 역행
    assert len(report.errors) == 1 and "beta" in report.errors[0]
    rotated = channelrepo.verify_all(channelrepo.dir_fetch(tmp_path), [other_key.public, key.public], now=T0)
    assert rotated.passed                                                            # 두 키 중 하나

    manifest = tmp_path / "releases/1.0.0/manifest.json"
    original = manifest.read_bytes()
    manifest.write_bytes(original.replace(b'"version":"1.0.0"', b'"version":"1.0.9"'))
    report = check(tmp_path, key)
    assert not report.passed and all("releases/1.0.0/manifest.json" in e for e in report.errors)
    manifest.write_bytes(original)

    (tmp_path / "releases/1.0.0/manifest.json.sig").unlink()
    assert any("없다" in e for e in check(tmp_path, key).errors)


def test_verify_all_requires_stable_releases_in_beta(tmp_path, key, make_manifest):
    publish(tmp_path, make_manifest("1.0.0"), "stable", key)
    beta = channelrepo.load_channel(tmp_path, "beta")
    emptied = Channel("beta", beta.sequence + 1, beta.generated, beta.expires, ())
    (tmp_path / "channels/beta.json").write_bytes(emptied.to_bytes())
    sign.sign_file(tmp_path / "channels/beta.json", key.private)
    report = check(tmp_path, key)
    assert not report.passed and "1.0.0" in report.errors[0]


def test_publish_without_key_leaves_files_unsigned(tmp_path, key, make_manifest):
    m = make_manifest("1.0.0-beta.1")
    result = channelrepo.publish(tmp_path, m.to_bytes(), "beta", key=None, now=T0, expires_days=30)
    assert sorted(result.unsigned) == ["channels/beta.json", "releases/1.0.0-beta.1/manifest.json"]
    assert not list(tmp_path.rglob("*.sig"))
    assert not check(tmp_path, key, channels=("beta",)).passed
    for rel in result.unsigned:                       # 추후 별도 서명 시 통과
        sign.sign_file(tmp_path / rel, key.private)
    assert check(tmp_path, key, channels=("beta",)).passed


# ── 명령줄: 전체 흐름 ────────────────────────────────────────


def run(*argv):
    return main([str(a) for a in argv])


def test_cli_full_flow(tmp_path, key, settings, capsys, unpinned_compose_text):
    priv, pub = key.write(tmp_path)
    repo = tmp_path / "channel-repo"
    repo.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    (work / "digests.json").write_text(json.dumps(digests_doc("1.0.0-beta.1", settings)), encoding="utf-8")
    (work / "pins.json").write_text(json.dumps(PINS), encoding="utf-8")
    (work / "CHANGES.md").write_bytes("## 1.0.0-beta.1\r\n\r\n- 첫 공개 시험판\r\n".encode("utf-8"))
    apps = work / "apps"
    apps.mkdir()
    (apps / "workspace-desktop-setup.exe").write_bytes(b"installer-bytes")

    # manifest 생성 — 미고정 외부 이미지가 있으면 실패(리포의 compose 는 전부 고정되어 있으므로 고정을 제거한 사본으로 검증한다)
    (work / "unpinned-compose.yml").write_text(unpinned_compose_text, encoding="utf-8", newline="\n")
    args = ["make-manifest", "--version", "1.0.0-beta.1", "--digests", work / "digests.json",
            "--changelog-file", work / "CHANGES.md", "--apps-dir", apps, "-o", work / "manifest.json", "--now", "2026-12-01T09:00:00Z"]
    unpinned = [*args, "--compose", work / "unpinned-compose.yml"]
    assert run(*unpinned) == 2
    assert "postgres" in capsys.readouterr().err and not (work / "manifest.json").exists()
    assert run(*unpinned, "--pins", work / "pins.json") == 0
    assert Manifest.from_bytes((work / "manifest.json").read_bytes()).third_party["core"]["postgres"] == "postgres@" + PINS["postgres:16.16-alpine"]
    assert run(*args) == 0                                      # 리포의 compose 그대로면 pins 없이 성공
    beta = Manifest.from_bytes((work / "manifest.json").read_bytes())
    assert beta.changelog == "## 1.0.0-beta.1\n\n- 첫 공개 시험판\n" and beta.apps[0].kind == "windows-desktop"

    # Beta 게시
    assert run("publish", "--repo", repo, "--manifest", work / "manifest.json", "--channel", "beta",
               "--key", priv, "--now", "2026-12-01T09:00:00Z") == 0
    out = capsys.readouterr().out
    assert "git" in out and "push" in out                       # 수행할 작업을 안내한다
    assert not (repo / ".git").exists()                         # 커밋·푸시는 수행하지 않는다
    assert channelrepo.load_channel(repo, "beta").releases[0].summary == "1.0.0-beta.1"
    assert run("verify", "--repo", repo, "--pubkey", pub, "--channel", "beta", "--now", "2026-12-02T00:00:00Z") == 0

    # 승격 — 다이제스트는 동일, 태그 부여 명령은 출력만 수행
    capsys.readouterr()
    assert run("promote", "--repo", repo, "--version", "1.0.0-beta.1", "--key", priv, "--now", "2026-12-15T09:00:00Z") == 0
    out = capsys.readouterr().out
    assert out.count("docker buildx imagetools create --tag") == len(beta.images)
    assert "ghcr.io/just-workspace/just-workspace-backend:1.0.0 " in out
    stable = Manifest.from_bytes((repo / "releases/1.0.0/manifest.json").read_bytes())
    assert stable.images == beta.images and stable.third_party == beta.third_party
    assert stable.version == "1.0.0" and stable.promoted_from == "1.0.0-beta.1"
    assert (repo / "releases/1.0.0-beta.1/manifest.json").read_bytes() == beta.to_bytes()   # Beta 측은 변경 없음
    assert [r.version for r in channelrepo.load_channel(repo, "stable").releases] == ["1.0.0"]
    assert [r.version for r in channelrepo.load_channel(repo, "beta").releases] == ["1.0.0-beta.1", "1.0.0"]

    # 전체 검증, 만료, 만료 갱신
    assert run("verify", "--repo", repo, "--pubkey", pub, "--now", "2026-12-16T00:00:00Z") == 0
    assert run("verify", "--repo", repo, "--pubkey", pub, "--now", "2027-02-01T00:00:00Z") == 0      # 기본 만료 90일 이내
    assert run("verify", "--repo", repo, "--pubkey", pub, "--now", "2027-04-01T00:00:00Z") == 1
    assert run("refresh", "--repo", repo, "--key", priv, "--now", "2027-03-10T00:00:00Z") == 0
    assert run("verify", "--repo", repo, "--pubkey", pub, "--now", "2027-04-01T00:00:00Z") == 0
    assert channelrepo.load_channel(repo, "stable").sequence == 2

    # 설치 관리자 측 흐름: 채널 → 판정 → manifest
    keys = verify.load_public_keys([pub.read_bytes()])
    from jwrelease.model import parse_time

    ch = verify.verify_channel(
        (repo / "channels/stable.json").read_bytes(), (repo / "channels/stable.json.sig").read_bytes(), keys,
        now=parse_time("2027-01-11T00:00:00Z"), expected_channel="stable", last_sequence=1,
    )
    plan = verify.plan_update("1.0.0-beta.1", ch)
    assert plan.action == verify.ACTION_UPDATE and plan.path == ("1.0.0",)
    entry = ch.find("1.0.0")
    got = verify.verify_manifest(
        (repo / entry.manifest_path).read_bytes(), (repo / (entry.manifest_path + ".sig")).read_bytes(), keys, entry
    )
    assert got == stable


def test_cli_promote_refuses_unknown_or_tampered(tmp_path, key, other_key, make_manifest, capsys):
    priv, pub = key.write(tmp_path)
    repo = tmp_path / "repo"
    repo.mkdir()
    assert run("promote", "--repo", repo, "--version", "1.0.0-beta.1", "--key", priv) == 2
    publish(repo, make_manifest("1.0.0-beta.1"), "beta", other_key)             # 다른 키로 서명된 Beta
    assert run("promote", "--repo", repo, "--version", "1.0.0-beta.1", "--key", priv) == 2
    assert not (repo / "releases/1.0.0").exists()
    capsys.readouterr()


def test_cli_sign_and_no_sign(tmp_path, key, make_manifest, capsys):
    priv, pub = key.write(tmp_path)
    repo = tmp_path / "repo"
    repo.mkdir()
    mpath = tmp_path / "manifest.json"
    mpath.write_bytes(make_manifest("1.0.0-beta.1").to_bytes())
    assert run("publish", "--repo", repo, "--manifest", mpath, "--channel", "beta") == 2          # 키와 --no-sign 모두 없음
    now = ("--now", "2026-12-01T09:00:00Z")
    assert run("publish", "--repo", repo, "--manifest", mpath, "--channel", "beta", "--no-sign", *now) == 0
    assert "cosign sign-blob" in capsys.readouterr().out
    assert run("verify", "--repo", repo, "--pubkey", pub, "--channel", "beta", *now) == 1
    assert run("sign", "--key", priv, repo / "channels/beta.json", repo / "releases/1.0.0-beta.1/manifest.json") == 0
    assert run("verify", "--repo", repo, "--pubkey", pub, "--channel", "beta", *now) == 0
    capsys.readouterr()


def test_cli_images_report(capsys):
    assert run("images") == 0
    out = capsys.readouterr().out
    assert "rbi-mirror" in out and "target=prod" in out and "다이제스트 없음" not in out      # 외부 이미지는 전부 고정되어 있다
