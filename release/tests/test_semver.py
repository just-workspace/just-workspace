import random

import pytest

from jwrelease import semver
from jwrelease.semver import Version, VersionError

# semver.org 11번 항목의 순서 예시 + 제품이 쓰는 꼴
ORDERED = [
    "0.9.9",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.1",
    "1.0.0-beta.2",
    "1.0.0-beta.10",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1-beta.1",
    "1.0.1",
    "1.1.0",
    "1.10.0",
    "2.0.0-beta.1",
    "2.0.0",
]


def test_order_matches_spec():
    versions = [Version.parse(v) for v in ORDERED]
    for a, b in zip(versions, versions[1:]):
        assert a < b and b > a and a != b, (str(a), str(b))
    shuffled = versions[:]
    random.Random(7).shuffle(shuffled)
    assert sorted(shuffled) == versions


def test_numeric_identifiers_compare_as_numbers():
    assert semver.compare("1.0.0-beta.2", "1.0.0-beta.10") == -1
    assert semver.compare("1.0.0-beta.10", "1.0.0-beta.9") == 1


def test_numeric_lower_than_alphanumeric_and_longer_wins():
    assert semver.compare("1.0.0-1", "1.0.0-a") == -1
    assert semver.compare("1.0.0-beta", "1.0.0-beta.1") == -1


def test_prerelease_below_release():
    assert semver.compare("1.2.0-beta.3", "1.2.0") == -1
    assert semver.compare("1.2.0", "1.2.0-beta.3") == 1


def test_build_metadata_ignored():
    assert semver.compare("1.0.0+a", "1.0.0+b") == 0
    assert Version.parse("1.0.0+a") == Version.parse("1.0.0")
    assert hash(Version.parse("1.0.0+a")) == hash(Version.parse("1.0.0"))


def test_round_trip_text():
    for text in ORDERED + ["1.2.3-beta.4+build.5"]:
        assert str(Version.parse(text)) == text


@pytest.mark.parametrize(
    "bad",
    ["", "1", "1.0", "1.0.0.0", "v1.0.0", "01.0.0", "1.00.0", "1.0.0-", "1.0.0-01", "1.0.0-beta..1", "1.0.0 ", "a.b.c", None, 100],
)
def test_rejects_invalid(bad):
    with pytest.raises(VersionError):
        Version.parse(bad)


def test_product_version_forms():
    assert semver.is_stable("1.0.0") and not semver.is_stable("1.0.0-beta.1")
    assert semver.is_beta("1.0.0-beta.1") and semver.is_beta("1.0.0-beta.12")
    for bad in ["1.0.0-beta", "1.0.0-beta.0", "1.0.0-rc.1", "1.0.0-beta.1.2", "1.0.0+x", "1.0", None]:
        assert not semver.is_product_version(bad), bad


def test_stable_of():
    assert semver.stable_of("1.2.0-beta.3") == "1.2.0"
    with pytest.raises(VersionError):
        semver.stable_of("1.2.0")
