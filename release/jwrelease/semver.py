"""버전 비교 — semver 2.0.0 규칙을 그대로 구현한다(외부 의존성 없음).

제품 버전은 두 꼴만 쓴다: Stable `X.Y.Z`, Beta `X.Y.Z-beta.N`.
비교 자체는 semver 전체 규칙을 따른다(프리릴리스 식별자 비교, 빌드 메타데이터 무시).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import total_ordering

_NUM = r"(?:0|[1-9][0-9]*)"
_PRE_ID = r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
_SEMVER = re.compile(
    rf"({_NUM})\.({_NUM})\.({_NUM})"
    rf"(?:-({_PRE_ID}(?:\.{_PRE_ID})*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
)
_STABLE = re.compile(rf"{_NUM}\.{_NUM}\.{_NUM}")
_BETA = re.compile(rf"{_NUM}\.{_NUM}\.{_NUM}-beta\.[1-9][0-9]*")


class VersionError(ValueError):
    """버전 문자열이 규칙에 맞지 않는다."""


@total_ordering
@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    pre: tuple[str, ...] = ()
    build: str = ""

    @classmethod
    def parse(cls, text: str) -> "Version":
        if not isinstance(text, str):
            raise VersionError(f"버전은 문자열이어야 한다: {text!r}")
        m = _SEMVER.fullmatch(text)
        if not m:
            raise VersionError(f"semver 가 아니다: {text!r}")
        pre = tuple(m.group(4).split(".")) if m.group(4) else ()
        return cls(int(m.group(1)), int(m.group(2)), int(m.group(3)), pre, m.group(5) or "")

    @property
    def is_prerelease(self) -> bool:
        return bool(self.pre)

    @property
    def base(self) -> "Version":
        """프리릴리스·빌드 표기를 뗀 `X.Y.Z`."""
        return Version(self.major, self.minor, self.patch)

    def _key(self):
        # 프리릴리스가 없는 쪽이 더 높다. 식별자는 숫자 < 영숫자, 숫자끼리는 수로, 나머지는 ASCII 순,
        # 앞부분이 같으면 식별자가 많은 쪽이 높다.
        pre = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in self.pre)
        return (self.major, self.minor, self.patch, 0 if self.pre else 1, pre)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Version):
            return NotImplemented
        return self._key() == other._key()

    def __lt__(self, other: "Version") -> bool:
        if not isinstance(other, Version):
            return NotImplemented
        return self._key() < other._key()

    def __hash__(self) -> int:
        return hash(self._key())

    def __str__(self) -> str:
        text = f"{self.major}.{self.minor}.{self.patch}"
        if self.pre:
            text += "-" + ".".join(self.pre)
        if self.build:
            text += "+" + self.build
        return text


def parse(text: str) -> Version:
    return Version.parse(text)


def compare(a: str, b: str) -> int:
    """a < b 이면 -1, 같으면 0, a > b 이면 1."""
    va, vb = Version.parse(a), Version.parse(b)
    return -1 if va < vb else (1 if va > vb else 0)


def is_stable(text: str) -> bool:
    """제품의 Stable 꼴(`X.Y.Z`)인가."""
    return isinstance(text, str) and bool(_STABLE.fullmatch(text))


def is_beta(text: str) -> bool:
    """제품의 Beta 꼴(`X.Y.Z-beta.N`, N ≥ 1)인가."""
    return isinstance(text, str) and bool(_BETA.fullmatch(text))


def is_product_version(text: str) -> bool:
    return is_stable(text) or is_beta(text)


def stable_of(text: str) -> str:
    """Beta 버전이 승격되면 갖게 되는 Stable 버전(`1.2.0-beta.3` → `1.2.0`)."""
    if not is_beta(text):
        raise VersionError(f"Beta 버전이 아니다: {text!r}")
    return str(Version.parse(text).base)
