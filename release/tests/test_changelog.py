"""리포의 변경 기록(CHANGELOG.md) — 현재 VERSION 의 절이 존재하며 릴리스 도구로 추출할 수 있는지 대조한다.

릴리스 절차의 `make-manifest --changelog-section` 이 실패하지 않도록, 버전을 올리는 커밋에서 해당 절을 함께 작성하게 한다.
Beta 버전이면 승격 후의 Stable 버전의 절도 요구한다(`promote --changelog-section`).
"""

from jwrelease import builder, semver

from conftest import REPO_ROOT


def _read():
    return (REPO_ROOT / "CHANGELOG.md").read_text(encoding="utf-8"), (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()


def test_changelog_has_section_for_current_version():
    text, version = _read()
    section = builder.changelog_section(text, version)
    assert builder.summary_line(section), "절의 첫 줄(요약)이 비어 있다"
    assert f"## {version}" not in section


def test_changelog_has_section_for_promoted_stable():
    text, version = _read()
    if not semver.is_beta(version):
        return
    stable = semver.stable_of(version)
    assert builder.summary_line(builder.changelog_section(text, stable))
