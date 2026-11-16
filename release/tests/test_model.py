import json
from datetime import datetime, timedelta, timezone

import pytest

from jwrelease.model import (
    Channel,
    FormatError,
    Manifest,
    ReleaseEntry,
    canonical_bytes,
    format_time,
    loads,
    new_channel,
    parse_time,
    zones_fingerprint,
)

from conftest import T0

SHA = "ab" * 32


def entry(version, muf=None, published="2026-12-01T09:00:00Z"):
    return ReleaseEntry(version, published, f"releases/{version}/manifest.json", SHA, muf, "요약")


def test_canonical_bytes_exact_form():
    data = {"b": 1, "a": {"z": None, "y": [True, "한글", 2]}, "c": "x"}
    assert canonical_bytes(data) == '{"a":{"y":[true,"한글",2],"z":null},"b":1,"c":"x"}\n'.encode("utf-8")


def test_canonical_bytes_independent_of_input_order_and_whitespace():
    a = {"x": 1, "y": {"b": 2, "a": 3}, "list": [3, 1, 2]}
    b = json.loads('{ "list": [3, 1, 2],\n "y": {"a": 3, "b": 2},  "x": 1 }')
    out = canonical_bytes(a)
    assert out == canonical_bytes(b)
    assert out.endswith(b"}\n") and out.count(b"\n") == 1
    assert b"\r" not in out and b" " not in out


def test_canonical_bytes_keeps_array_order():
    assert canonical_bytes({"a": [2, 1]}) != canonical_bytes({"a": [1, 2]})


def test_canonical_bytes_utf8_not_escaped():
    out = canonical_bytes({"k": "변경 내용 — é"})
    assert "변경 내용 — é".encode("utf-8") in out and b"\\u" not in out


@pytest.mark.parametrize("bad", [{"a": 1.5}, {"a": float("nan")}, {"a": {1: 2}}, {"a": b"x"}, {"a": {"b": [object()]}}])
def test_canonical_bytes_rejects_unstable_values(bad):
    with pytest.raises(FormatError):
        canonical_bytes(bad)


@pytest.mark.parametrize("bad", [b'{"a":1,"a":2}', b'{"a":1.0}', b'{"a":NaN}', b"[1]", b"\xff", b"{"])
def test_loads_rejects_duplicate_keys_floats_and_non_objects(bad):
    with pytest.raises(FormatError):
        loads(bad)


def test_time_round_trip_and_strictness():
    t = datetime(2026, 12, 1, 18, 0, 0, 123456, tzinfo=timezone(timedelta(hours=9)))
    assert format_time(t) == "2026-12-01T09:00:00Z"
    assert parse_time("2026-12-01T09:00:00Z") == T0
    for bad in ["2026-12-01 09:00:00", "2026-12-01T09:00:00+00:00", "2026-13-01T09:00:00Z", "", None]:
        with pytest.raises(FormatError):
            parse_time(bad)
    with pytest.raises(ValueError):
        format_time(datetime(2026, 1, 1))


def test_channel_round_trip_is_byte_identical():
    ch = new_channel("beta").with_release(entry("1.0.0-beta.1")).with_release(entry("1.0.0")).bumped(T0, 30)
    data = ch.to_bytes()
    assert Channel.from_bytes(data) == ch
    assert Channel.from_bytes(data).to_bytes() == data
    assert ch.sequence == 1 and ch.expires == "2026-12-31T09:00:00Z"


def test_channel_sorts_releases_and_bumps_sequence():
    ch = new_channel("beta")
    for v in ["1.1.0", "1.0.0-beta.2", "1.0.0", "1.0.0-beta.10"]:
        ch = ch.with_release(entry(v))
    assert [r.version for r in ch.releases] == ["1.0.0-beta.2", "1.0.0-beta.10", "1.0.0", "1.1.0"]
    assert ch.bumped(T0, 30).bumped(T0, 30).sequence == 2


def test_channel_rejects_bad_content():
    good = new_channel("stable").with_release(entry("1.0.0")).bumped(T0, 30).to_dict()
    Channel.from_dict(good)

    def broken(**change):
        d = json.loads(json.dumps(good))
        d.update(change)
        return d

    cases = [
        broken(format=2),
        broken(channel="nightly"),
        broken(sequence=0),
        broken(sequence=True),
        broken(expires=good["generated"]),
        broken(extra=1),
        broken(releases=[entry("1.0.0-beta.1").to_dict()]),                      # stable 채널에 Beta
        broken(releases=[entry("1.0.0").to_dict(), entry("1.0.0").to_dict()]),   # 중복
        broken(releases=[entry("1.1.0").to_dict(), entry("1.0.0").to_dict()]),   # 순서
        broken(releases=[{**entry("1.0.0").to_dict(), "summary": "두\n줄"}]),
        broken(releases=[{**entry("1.0.0").to_dict(), "manifest": {"path": "../x", "sha256": SHA}}]),
        broken(releases=[{**entry("1.0.0").to_dict(), "manifest": {"path": "a", "sha256": "AB" * 32}}]),
        broken(releases=[{k: v for k, v in entry("1.0.0").to_dict().items() if k != "min_upgrade_from"}]),
    ]
    for d in cases:
        with pytest.raises(FormatError):
            Channel.from_dict(d)
    with pytest.raises(FormatError):
        new_channel("stable").with_release(entry("1.0.0-beta.1"))
    with pytest.raises(FormatError):
        new_channel("beta").with_release(entry("1.0.0")).with_release(entry("1.0.0"))


def test_manifest_round_trip_is_byte_identical(make_manifest):
    m = make_manifest()
    data = m.to_bytes()
    assert Manifest.from_bytes(data) == m
    assert Manifest.from_bytes(data).to_bytes() == data
    assert data == canonical_bytes(json.loads(data))


def test_manifest_rejects_bad_content(make_manifest):
    good = make_manifest().to_dict()
    Manifest.from_dict(good)

    def broken(**change):
        d = json.loads(json.dumps(good))
        d.update(change)
        return d

    cases = [
        broken(format=9),
        broken(version="1.0"),
        broken(images={}),
        broken(images={"backend": "ghcr.io/x/backend:1.0.0"}),              # 태그 참조
        broken(images={"backend": "ghcr.io/x/backend@sha256:abc"}),
        broken(third_party={"core": {"postgres": "postgres:16"}}),
        broken(promoted_from="1.0.0-beta.1"),                               # 이 버전은 Stable 이 아님
        broken(apps=[{"kind": "ios", "filename": "a", "size": 1, "sha256": "0" * 64, "url": "https://x/a"}]),
        broken(offline_bundle={"url": "ftp://x", "size": 1, "sha256": "0" * 64}),
        broken(unknown=True),
        {k: v for k, v in good.items() if k != "plugin_api"},
    ]
    for d in cases:
        with pytest.raises(FormatError):
            Manifest.from_dict(d)


def test_zones_fingerprint_ignores_formatting(zones_raw):
    sha, content = zones_fingerprint(zones_raw)
    crlf = zones_raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    compact = json.dumps(json.loads(zones_raw), ensure_ascii=False).encode("utf-8")
    assert zones_fingerprint(crlf)[0] == sha == zones_fingerprint(compact)[0]
    changed = json.loads(zones_raw)
    changed["version"] = 999
    assert zones_fingerprint(json.dumps(changed).encode())[0] != sha
    assert content["core"]["id"] == "core"
