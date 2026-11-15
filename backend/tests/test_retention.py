"""버전·휴지통 만료 — 실제로 지우는 코드라 판정과 경로 범위를 꼼꼼히 본다."""

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.files import retention as rt

H = 3600 * 1000
D = 24 * H
NOW = 1_800_000_000_000          # 임의의 epoch ms


# ─── 간격표 판정 ───


def test_newest_is_always_kept():
    assert rt.plan_version_expiry([NOW - 500], NOW) == set()
    assert rt.plan_version_expiry([NOW - 365 * D], NOW) == set()


def test_within_last_hour_two_second_spacing():
    # 0.5초 간격 5개 → 2초 간격만 남는다
    ts = [NOW - i * 500 for i in range(5)]           # NOW, -0.5s, -1s, -1.5s, -2s
    drop = rt.plan_version_expiry(ts, NOW)
    kept = sorted(set(ts) - drop, reverse=True)
    assert kept[0] == NOW
    assert kept[1] == NOW - 2000                    # 정확히 2초 떨어진 것은 유지(< 비교)
    assert len(kept) == 2


def test_day_bucket_one_per_minute():
    # 나이 2~3시간: 10초 간격 30개 → 1분 간격 ≈ 6개
    base = NOW - 2 * H
    ts = [base - i * 10_000 for i in range(31)]     # 5분 범위
    drop = rt.plan_version_expiry(ts + [NOW], NOW)
    kept = sorted(set(ts) - drop, reverse=True)
    assert 5 <= len(kept) <= 6
    gaps = [a - b for a, b in zip(kept, kept[1:])]
    assert all(g >= 60_000 for g in gaps)


def test_week_month_and_beyond_buckets():
    # 3일 전: 10분 간격 → 1시간 간격 유지
    ts3d = [NOW - 3 * D - i * 10 * 60_000 for i in range(13)]        # 2시간 범위
    # 15일 전: 6시간 간격 → 1일 간격 유지
    ts15d = [NOW - 15 * D - i * 6 * H for i in range(9)]             # 2일 범위
    # 100일 전: 1일 간격 → 1주 간격 유지
    ts100d = [NOW - 100 * D - i * D for i in range(15)]              # 2주 범위
    all_ts = [NOW] + ts3d + ts15d + ts100d
    drop = rt.plan_version_expiry(all_ts, NOW)
    kept = sorted(set(all_ts) - drop, reverse=True)

    def kept_in(group):
        return [t for t in kept if t in set(group)]

    k3 = kept_in(ts3d)
    assert 2 <= len(k3) <= 3 and all(a - b >= H for a, b in zip(k3, k3[1:]))
    k15 = kept_in(ts15d)
    assert 2 <= len(k15) <= 3 and all(a - b >= D for a, b in zip(k15, k15[1:]))
    k100 = kept_in(ts100d)
    assert 2 <= len(k100) <= 3 and all(a - b >= 7 * D for a, b in zip(k100, k100[1:]))


def test_future_timestamp_treated_as_age_zero():
    ts = [NOW + 60_000, NOW + 59_500, NOW - 5000]
    drop = rt.plan_version_expiry(ts, NOW)
    assert NOW + 59_500 in drop and NOW + 60_000 not in drop and NOW - 5000 not in drop


def test_max_age_drops_everything_older_including_newest():
    ts = [NOW - 400 * D, NOW - 500 * D]
    assert rt.plan_version_expiry(ts, NOW, max_age_days=365) == set(ts)
    assert rt.plan_version_expiry(ts, NOW, max_age_days=0) == set()     # 0 = 상한 없음


def test_interval_table_values():
    assert rt.interval_for_age(0) == 2000
    assert rt.interval_for_age(H) == 2000
    assert rt.interval_for_age(H + 1) == 60_000
    assert rt.interval_for_age(D + 1) == H
    assert rt.interval_for_age(7 * D + 1) == D
    assert rt.interval_for_age(30 * D + 1) == 7 * D
    assert rt.interval_for_age(10 * 365 * D) == 7 * D


# ─── 실제 디렉터리 트리 ───


def _mk_versions(root: Path, owner: str, rel: str, stamps: list[int]) -> Path:
    d = root / ".versions" / owner / rel
    d.mkdir(parents=True)
    for s in stamps:
        (d / str(s)).write_bytes(b"x" * 10)
    return d


def test_expire_versions_removes_only_planned_and_leaves_others(tmp_path: Path):
    stamps = [NOW - 3 * D - i * 10 * 60_000 for i in range(7)]          # 3일 전, 10분 간격
    vdir = _mk_versions(tmp_path, "u1", "docs/a.txt", [NOW] + stamps)
    # 스냅샷이 아닌 파일(자릿수 아님)·다른 소유자 트리는 건드리면 안 된다
    (vdir / "notes.txt").write_text("keep")
    other = _mk_versions(tmp_path, "u2", "b.bin", [NOW - 1000])
    # 사용자 저장소(users/) 는 아예 범위 밖
    users = tmp_path / "users" / "u1"
    users.mkdir(parents=True)
    (users / "real.txt").write_text("real")

    stats = rt.expire_versions(tmp_path / ".versions", now_ms=NOW)

    expected_drop = rt.plan_version_expiry([NOW] + stamps, NOW)
    remaining = {int(f.name) for f in vdir.iterdir() if f.name.isdigit()}
    assert remaining == set([NOW] + stamps) - expected_drop
    assert stats.removed == len(expected_drop) and stats.errors == 0
    assert (vdir / "notes.txt").exists()
    assert (other / str(NOW - 1000)).exists()
    assert (users / "real.txt").exists()
    assert all(p.startswith(str(tmp_path / ".versions")) for p in stats.removed_paths)


def test_expire_versions_refuses_wrong_root(tmp_path: Path):
    (tmp_path / "users").mkdir()
    (tmp_path / "users" / "123").write_text("x")
    stats = rt.expire_versions(tmp_path / "users", now_ms=NOW)
    assert stats.removed == 0 and (tmp_path / "users" / "123").exists()


def test_expire_versions_prunes_empty_relpath_dir_but_keeps_owner(tmp_path: Path):
    vdir = _mk_versions(tmp_path, "u1", "gone/file.txt", [NOW - 400 * D, NOW - 401 * D])
    rt.expire_versions(tmp_path / ".versions", now_ms=NOW, max_age_days=365)
    assert not vdir.exists() and not vdir.parent.exists()
    assert (tmp_path / ".versions" / "u1").is_dir()


@pytest.mark.skipif(os.name == "nt" and not hasattr(os, "symlink"), reason="symlink 불가")
def test_symlink_inside_versions_is_not_followed(tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    victim = outside / str(NOW - 400 * D)
    victim.write_text("do not delete")
    vroot = tmp_path / ".versions" / "u1"
    vroot.mkdir(parents=True)
    try:
        os.symlink(outside, vroot / "linked", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("이 환경에서는 symlink 를 만들 수 없다")
    rt.expire_versions(tmp_path / ".versions", now_ms=NOW, max_age_days=1)
    assert victim.exists()


def test_remove_within_rejects_outside_path(tmp_path: Path):
    root = tmp_path / ".trash"
    root.mkdir()
    outside = tmp_path / "precious.txt"
    outside.write_text("x")
    stats = rt.Stats()
    rt.remove_within(outside, root, stats)
    assert outside.exists() and stats.errors == 1 and stats.removed == 0
    # `..` 로 들어오는 경로도 어휘적 검사에서 걸린다
    rt.remove_within(root / ".." / "precious.txt", root, stats)
    assert outside.exists() and stats.errors == 2


# ─── 휴지통 ───


def _mk_trash(user_dir: Path, name: str, trashed_at: datetime | None, is_dir=False) -> None:
    trash = user_dir / ".trash"
    trash.mkdir(parents=True, exist_ok=True)
    p = trash / name
    if is_dir:
        p.mkdir()
        (p / "inner.txt").write_text("inner")
    else:
        p.write_text("data")
    if trashed_at is not None:
        meta_path = user_dir / ".trash_meta.json"
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        meta[name] = {"original_path": f"my/{name}", "trashed_at": trashed_at.isoformat()}
        meta_path.write_text(json.dumps(meta))


def test_trash_expiry_by_meta_name_fallback_and_unknown(tmp_path: Path):
    now = datetime(2026, 10, 15, tzinfo=timezone.utc)
    user_dir = tmp_path / "users" / "u1"
    _mk_trash(user_dir, "20260101000000_old.txt", now - timedelta(days=40))        # 메타 있음, 만료
    _mk_trash(user_dir, "20261010000000_new.txt", now - timedelta(days=5))         # 메타 있음, 유지
    _mk_trash(user_dir, "20260201000000_nometa.txt", None)                          # 메타 없음 → 이름으로 만료
    _mk_trash(user_dir, "weird_name.txt", None)                                     # 근거 없음 → 유지
    _mk_trash(user_dir, "20260101000000_folder", now - timedelta(days=40), is_dir=True)
    keep_file = user_dir / "keep.txt"
    keep_file.write_text("mine")

    stats = rt.expire_all_trash(tmp_path / "users", retention_days=30, now=now)

    trash = user_dir / ".trash"
    assert not (trash / "20260101000000_old.txt").exists()
    assert not (trash / "20260201000000_nometa.txt").exists()
    assert not (trash / "20260101000000_folder").exists()
    assert (trash / "20261010000000_new.txt").exists()
    assert (trash / "weird_name.txt").exists()
    assert keep_file.exists()
    assert stats.removed == 3 and stats.errors == 0
    meta = json.loads((user_dir / ".trash_meta.json").read_text())
    assert "20260101000000_old.txt" not in meta and "20261010000000_new.txt" in meta


def test_trash_retention_zero_disables(tmp_path: Path):
    now = datetime(2026, 10, 15, tzinfo=timezone.utc)
    user_dir = tmp_path / "users" / "u1"
    _mk_trash(user_dir, "20200101000000_ancient.txt", now - timedelta(days=2000))
    stats = rt.expire_all_trash(tmp_path / "users", retention_days=0, now=now)
    assert stats.removed == 0 and (user_dir / ".trash" / "20200101000000_ancient.txt").exists()


def test_trashed_at_from_name():
    assert rt.trashed_at_from_name("20260301120000_a_b.txt") == datetime(2026, 3, 1, 12, 0, 0, tzinfo=timezone.utc)
    assert rt.trashed_at_from_name("20260301120000_1_a.txt") is not None
    assert rt.trashed_at_from_name("report.txt") is None
    assert rt.trashed_at_from_name("99999999999999_x") is None
