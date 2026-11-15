import pytest

from jwrelease import verify
from jwrelease.model import ReleaseEntry, new_channel

from conftest import T0

SHA = "cd" * 32


def rel(version, muf=None):
    return ReleaseEntry(version, "2026-12-01T09:00:00Z", f"releases/{version}/manifest.json", SHA, muf, "")


def channel(name, *releases):
    ch = new_channel(name)
    for r in releases:
        ch = ch.with_release(r)
    return ch.bumped(T0, 30)


# 1.0 → 1.1 → 1.2(1.1 이상에서만) → 2.0(1.2 이상에서만) → 2.1(2.0 이상에서만)
LINE = [rel("1.0.0"), rel("1.0.1"), rel("1.1.0"), rel("1.2.0", "1.1.0"), rel("2.0.0", "1.2.0"), rel("2.1.0", "2.0.0")]


def test_direct_when_no_constraint():
    assert verify.upgrade_path("1.0.0", "1.1.0", LINE) == ["1.1.0"]


def test_direct_when_current_meets_minimum():
    assert verify.upgrade_path("1.1.0", "1.2.0", LINE) == ["1.2.0"]
    assert verify.upgrade_path("1.2.0", "2.0.0", LINE) == ["2.0.0"]


def test_one_intermediate():
    assert verify.upgrade_path("1.0.0", "1.2.0", LINE) == ["1.1.0", "1.2.0"]


def test_chain_of_intermediates():
    assert verify.upgrade_path("1.0.0", "2.1.0", LINE) == ["1.1.0", "1.2.0", "2.0.0", "2.1.0"]
    assert verify.upgrade_path("1.1.0", "2.1.0", LINE) == ["1.2.0", "2.0.0", "2.1.0"]


def test_fewest_hops_and_highest_intermediate_preferred():
    releases = [rel("1.0.0"), rel("1.1.0"), rel("1.2.0"), rel("1.3.0"), rel("2.0.0", "1.1.0")]
    # 1.1.0·1.2.0·1.3.0 어느 것을 거쳐도 2.0.0 으로 갈 수 있다 — 가장 높은 1.3.0 하나만 거친다
    assert verify.upgrade_path("1.0.0", "2.0.0", releases) == ["1.3.0", "2.0.0"]


def test_already_there_is_empty():
    assert verify.upgrade_path("1.1.0", "1.1.0", LINE) == []


def test_downgrade_refused():
    with pytest.raises(verify.UpgradeError):
        verify.upgrade_path("1.2.0", "1.1.0", LINE)


def test_unknown_target_refused():
    with pytest.raises(verify.UpgradeError):
        verify.upgrade_path("1.0.0", "9.9.9", LINE)


def test_no_path_when_stepping_stone_missing():
    releases = [rel("1.0.0"), rel("2.0.0", "1.5.0")]
    with pytest.raises(verify.UpgradeError) as e:
        verify.upgrade_path("1.0.0", "2.0.0", releases)
    assert "1.5.0" in str(e.value)


def test_current_version_need_not_be_listed():
    assert verify.upgrade_path("1.0.5", "1.2.0", LINE) == ["1.1.0", "1.2.0"]
    assert verify.upgrade_path("1.1.3", "1.2.0", LINE) == ["1.2.0"]


def test_prerelease_ordering_in_minimum():
    releases = [rel("1.1.0-beta.1"), rel("1.1.0-beta.2", "1.1.0-beta.1"), rel("1.1.0", "1.1.0-beta.2")]
    assert verify.upgrade_path("1.0.0", "1.1.0", releases) == ["1.1.0-beta.1", "1.1.0-beta.2", "1.1.0"]
    assert verify.upgrade_path("1.1.0-beta.2", "1.1.0", releases) == ["1.1.0"]


def test_can_upgrade_directly():
    assert verify.can_upgrade_directly("1.1.0", rel("1.2.0", "1.1.0"))
    assert not verify.can_upgrade_directly("1.0.9", rel("1.2.0", "1.1.0"))
    assert not verify.can_upgrade_directly("1.2.0", rel("1.2.0"))        # 같은 버전
    assert not verify.can_upgrade_directly("1.3.0", rel("1.2.0"))        # 내려가는 방향


# ── plan_update ─────────────────────────────────────────────


def test_plan_update_when_newer_exists():
    plan = verify.plan_update("1.0.0", channel("stable", *LINE))
    assert plan.action == verify.ACTION_UPDATE
    assert plan.target == "2.1.0" and plan.path == ("1.1.0", "1.2.0", "2.0.0", "2.1.0")


def test_plan_current_when_latest():
    plan = verify.plan_update("2.1.0", channel("stable", *LINE))
    assert plan.action == verify.ACTION_CURRENT and plan.path == ()
    assert verify.plan_update("1.0.0", new_channel("stable").bumped(T0, 30)).action == verify.ACTION_CURRENT


def test_plan_blocked_when_no_path():
    plan = verify.plan_update("1.0.0", channel("stable", rel("1.0.0"), rel("2.0.0", "1.5.0")))
    assert plan.action == verify.ACTION_BLOCKED and plan.target == "2.0.0" and plan.reason


def test_beta_to_stable_waits_until_stable_catches_up():
    """Beta 를 쓰다가 Stable 채널로 바꿨다: Stable 이 현재 버전 이상이 될 때까지 내려가지 않고 기다린다."""
    current = "1.2.0-beta.3"
    stable_behind = channel("stable", rel("1.0.0"), rel("1.1.4"))
    plan = verify.plan_update(current, stable_behind)
    assert plan.action == verify.ACTION_WAIT and plan.target == "1.1.4" and plan.path == ()

    # 더 낮은 계열의 패치가 나와도 여전히 기다린다
    plan = verify.plan_update(current, channel("stable", rel("1.0.0"), rel("1.1.4"), rel("1.1.5")))
    assert plan.action == verify.ACTION_WAIT

    # Stable 1.2.0 이 나오면(1.2.0 > 1.2.0-beta.3) 올라간다
    caught_up = channel("stable", rel("1.0.0"), rel("1.1.4"), rel("1.2.0"))
    plan = verify.plan_update(current, caught_up)
    assert plan.action == verify.ACTION_UPDATE and plan.path == ("1.2.0",)


def test_beta_channel_offers_beta_and_stable():
    beta = channel("beta", rel("1.0.0"), rel("1.1.0-beta.1"), rel("1.1.0-beta.2"))
    plan = verify.plan_update("1.0.0", beta)
    assert plan.action == verify.ACTION_UPDATE and plan.target == "1.1.0-beta.2" and plan.path == ("1.1.0-beta.2",)
    beta = channel("beta", rel("1.0.0"), rel("1.1.0-beta.1"), rel("1.1.0-beta.2"), rel("1.1.0"))
    assert verify.plan_update("1.1.0-beta.2", beta).path == ("1.1.0",)


def test_stable_user_switching_to_beta_updates_immediately():
    beta = channel("beta", rel("1.0.0"), rel("1.1.0-beta.1"))
    assert verify.plan_update("1.0.0", beta).action == verify.ACTION_UPDATE
