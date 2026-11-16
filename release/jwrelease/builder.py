"""manifest 생성 및 승격 — 릴리스 게시 측 도구의 본체(파일 입출력은 호출자가 수행한다)."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

from . import compose, semver
from .config import Settings
from .model import AppFile, FileRef, FormatError, Manifest, format_time, loads, sha256_hex, zones_fingerprint

DIGESTS_FORMAT = 1
APP_KIND_BY_SUFFIX = {".exe": "windows-desktop", ".apk": "android"}


class BuildError(ValueError):
    """manifest 생성 불가(입력 간 불일치)."""


@dataclass(frozen=True)
class Digests:
    """빌드 서버가 생성한 `digests.json` — 이름 → (저장소, 다이제스트)."""

    version: str
    registry: str
    images: dict[str, tuple[str, str]]
    commit: str = ""

    @classmethod
    def from_bytes(cls, data: bytes) -> "Digests":
        try:
            d = loads(data)
        except FormatError as e:
            raise BuildError(f"digests.json: {e}") from None
        if d.get("format") != DIGESTS_FORMAT:
            raise BuildError(f"digests.json: 모르는 형식 버전 {d.get('format')!r}")
        version = d.get("version")
        if not isinstance(version, str) or not version:
            raise BuildError("digests.json: version 이 없다")
        raw = d.get("images")
        if not isinstance(raw, dict) or not raw:
            raise BuildError("digests.json: images 가 비어 있다")
        images: dict[str, tuple[str, str]] = {}
        for name, item in raw.items():
            if not isinstance(item, dict):
                raise BuildError(f"digests.json: images.{name} 이 객체가 아니다")
            repo, digest = item.get("repository"), item.get("digest")
            if not isinstance(repo, str) or not repo or "@" in repo or ":" in repo.rsplit("/", 1)[-1]:
                raise BuildError(f"digests.json: images.{name}.repository 가 저장소 이름이 아니다")
            if not isinstance(digest, str) or not compose.DIGEST.fullmatch(digest):
                raise BuildError(f"digests.json: images.{name}.digest 가 sha256 다이제스트가 아니다")
            images[name] = (repo, digest)
        return cls(version, str(d.get("registry") or ""), images, str(d.get("commit") or ""))


def file_ref(path: Path, url: str) -> FileRef:
    data = path.read_bytes()
    return FileRef(url, len(data), sha256_hex(data))


def collect_apps(apps_dir: Path, version: str, settings: Settings) -> tuple[AppFile, ...]:
    """디렉터리의 설치 파일(`.exe` → windows-desktop, `.apk` → android). 종류별로 하나만 허용한다."""
    found: dict[str, AppFile] = {}
    for path in sorted(apps_dir.iterdir()):
        kind = APP_KIND_BY_SUFFIX.get(path.suffix.lower())
        if kind is None or not path.is_file():
            continue
        if kind in found:
            raise BuildError(f"앱 파일 디렉터리에 {kind} 파일이 둘 이상이다: {found[kind].filename}, {path.name}")
        data = path.read_bytes()
        found[kind] = AppFile(kind, path.name, len(data), sha256_hex(data), settings.download_url(version, path.name))
    return tuple(found[k] for k in sorted(found))


def make_manifest(
    *,
    version: str,
    digests: Digests,
    compose_text: str,
    zones_raw: bytes,
    settings: Settings,
    published: datetime,
    min_upgrade_from: str | None = None,
    changelog: str = "",
    apps: tuple[AppFile, ...] = (),
    offline_bundle: FileRef | None = None,
    installer_bundle: FileRef | None = None,
    db_schema: int | str | None = None,
    plugin_api: dict[str, Any] | None = None,
    pins: Mapping[str, str] | None = None,
    resolver: compose.Resolver | None = None,
    download_bytes: int | None = None,
) -> Manifest:
    """빌드 결과(digests.json)와 compose·zones.json 으로 manifest 를 생성한다.

    검증 항목:
    - 버전 형식, `digests.json` 의 버전과 일치
    - compose 의 자체 빌드 이미지가 `digests.json` 에 전부 존재하고 저장소 이름이 동일
    - compose 밖의 추가 이미지(설치 관리자 등)는 설정의 저장소 이름 규칙과 동일
    - 외부 이미지(third-party)는 전부 다이제스트로 고정(미고정 시 `pins`·`resolver` 로 보완하고, 보완 불가 시 실패)
    - `min_upgrade_from` 이 이 버전보다 높지 않음
    """
    if not semver.is_product_version(version):
        raise BuildError(f"버전 꼴이 아니다(X.Y.Z 또는 X.Y.Z-beta.N): {version!r}")
    if digests.version != version:
        raise BuildError(f"digests.json 의 버전({digests.version})이 만들려는 버전({version})과 다르다")
    if download_bytes is not None and (isinstance(download_bytes, bool) or not isinstance(download_bytes, int)
                                       or download_bytes < 0):
        raise BuildError("download_bytes 는 0 이상의 정수여야 한다")
    if min_upgrade_from is not None:
        if not semver.is_product_version(min_upgrade_from):
            raise BuildError(f"min_upgrade_from 이 버전 꼴이 아니다: {min_upgrade_from!r}")
        if semver.parse(min_upgrade_from) > semver.parse(version):
            raise BuildError("min_upgrade_from 이 이 버전보다 높다")

    env = {"JW_REGISTRY": settings.registry, "JW_VERSION": version}
    try:
        images = compose.read_images(compose_text, env)
        zones_sha, zones_content = zones_fingerprint(zones_raw)
        third = compose.third_party_by_zone(images, zones_content, pins=pins, resolver=resolver)
    except (compose.ComposeError, FormatError) as e:
        raise BuildError(str(e)) from None

    ours: dict[str, str] = {}
    problems: list[str] = []
    own_names = {i.service for i in compose.own_images(images)}
    for image in compose.own_images(images):
        got = digests.images.get(image.service)
        if got is None:
            problems.append(f"{image.service}: digests.json 에 없다")
            continue
        repo, digest = got
        if repo != image.ref.repository:
            problems.append(f"{image.service}: 저장소가 다르다(빌드 {repo}, compose {image.ref.repository})")
            continue
        ours[image.service] = f"{repo}@{digest}"
    for name, (repo, digest) in digests.images.items():
        if name in own_names:
            continue
        if repo != settings.image_repository(name):
            problems.append(f"{name}: compose 에 없는 이미지인데 저장소가 규칙과 다르다({repo})")
            continue
        ours[name] = f"{repo}@{digest}"
    if problems:
        raise BuildError("이미지 목록이 맞지 않는다: " + "; ".join(problems))

    return Manifest(
        version=version,
        published=format_time(published),
        images=ours,
        third_party=third,
        zones_sha256=zones_sha,
        zones_content=zones_content,
        min_upgrade_from=min_upgrade_from,
        db_schema=db_schema,
        installer_bundle=installer_bundle,
        apps=apps,
        offline_bundle=offline_bundle,
        changelog=changelog,
        plugin_api=plugin_api,
        download_bytes=download_bytes,
    )


def total_image_size(manifest: Manifest, size_of) -> int:
    """manifest 의 모든 이미지(자체 빌드 이미지 + 외부 이미지)의 압축 크기 합. `size_of(저장소, 다이제스트)` 는 주입받는다."""
    total = 0
    for ref in sorted(set(manifest.all_image_refs().values())):
        repo, digest = ref.split("@", 1)
        total += size_of(repo, digest)
    return total


_KEEP = object()


def promote_manifest(
    beta: Manifest,
    *,
    published: datetime,
    min_upgrade_from: Any = _KEEP,
    changelog: str | None = None,
) -> Manifest:
    """Beta manifest → Stable manifest. **이미지 다이제스트는 동일**하며 버전 문자열만 변경된다.

    오프라인 번들은 포함하지 않는다 — 번들 내부에 Beta manifest 가 포함되어 있어 Stable 용으로 재생성해야 한다
    (이미지 재빌드는 아니다).
    """
    if not semver.is_beta(beta.version):
        raise BuildError(f"Beta 릴리스가 아니다: {beta.version}")
    stable = semver.stable_of(beta.version)
    muf = beta.min_upgrade_from if min_upgrade_from is _KEEP else min_upgrade_from
    if muf is not None:
        if not semver.is_product_version(muf):
            raise BuildError(f"min_upgrade_from 이 버전 꼴이 아니다: {muf!r}")
        if semver.parse(muf) > semver.parse(stable):
            raise BuildError("min_upgrade_from 이 승격 버전보다 높다")
    return replace(
        beta,
        version=stable,
        published=format_time(published),
        min_upgrade_from=muf,
        promoted_from=beta.version,
        offline_bundle=None,
        changelog=beta.changelog if changelog is None else changelog,
    )


def retag_commands(manifest: Manifest, tag: str) -> list[list[str]]:
    """자체 빌드 이미지에 버전 태그를 부여하는 명령(재빌드 없음 — 동일 다이제스트에 태그만 부여)."""
    out = []
    for name in sorted(manifest.images):
        ref = manifest.images[name]
        repo = ref.split("@", 1)[0]
        out.append(["docker", "buildx", "imagetools", "create", "--tag", f"{repo}:{tag}", ref])
    return out


def summary_line(changelog: str) -> str:
    """변경 내용의 첫 유의미한 줄(제목 표시 `#`·목록 표시 제거) — 채널 파일의 요약 기본값."""
    for line in changelog.splitlines():
        text = line.strip().lstrip("#-* ").strip()
        if text:
            return text[:200]
    return ""
