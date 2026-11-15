"""오프라인 묶음 — 인터넷이 없는 서버에 옮겨 설치하기 위한 한 파일(tar).

묶음 안의 파일:

    bundle.json            묶음 색인(형식 버전, 제품 버전, 만든 시각, 파일 목록: 경로·크기·SHA-256, 이미지 표)
    bundle.json.sig        색인의 서명
    manifest.json          릴리스 목록 파일(이 묶음을 만들 때의 것 — `offline_bundle` 은 비어 있다)
    manifest.json.sig
    images/<이름>.tar      `docker save` 결과(이미지마다 하나)

검증 순서(`verify_bundle`):
  1. 묶음 서명 — `bundle.json.sig` 로 `bundle.json` 검증
  2. manifest — 색인에 적힌 해시와 일치 + `manifest.json.sig` 서명 + 색인의 버전·이미지 표와 일치
  3. 파일별 해시 — 색인의 모든 파일이 있고 크기·SHA-256 이 같으며, 색인에 없는 파일이 없다

`docker save`·`docker load` 실행은 여기서 하지 않는다. `save_commands()` 가 명령을 만들어 주고,
이미 저장된 `images/*.tar` 를 `write_index()` → (서명) → `pack()` 으로 묶는다.

적재 뒤의 이름: `docker load` 는 레지스트리 다이제스트를 되살리지 못한다. 그래서 묶음의 이미지는
태그로 저장한다 — 우리 이미지는 `저장소:<버전>`, 남의 이미지는 `저장소:jw-<다이제스트 앞 12자>`.
오프라인 설치는 다이제스트가 아니라 이 태그로 이미지를 가리켜야 한다(색인의 `images[].tag`).
"""

from __future__ import annotations

import hashlib
import tarfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from . import verify
from .model import FormatError, Manifest, canonical_bytes, format_time, loads, parse_time
from .sign import SIG_SUFFIX

BUNDLE_FORMAT = 1
INDEX = "bundle.json"
MANIFEST = "manifest.json"
IMAGES_DIR = "images"
_CHUNK = 1024 * 1024


class BundleError(Exception):
    """묶음을 만들 수 없거나 묶음이 올바르지 않다."""


def bundle_filename(version: str) -> str:
    return f"just-workspace-{version}-offline.tar"


def image_tags(manifest: Manifest, include_third_party: bool = False) -> dict[str, dict[str, str]]:
    """이름 → `{"ref": 저장소@다이제스트, "tag": 적재 뒤 이름, "file": 묶음 안 경로}`."""
    out: dict[str, dict[str, str]] = {}
    for name, ref in sorted(manifest.images.items()):
        repo = ref.split("@", 1)[0]
        out[name] = {"ref": ref, "tag": f"{repo}:{manifest.version}", "file": f"{IMAGES_DIR}/{name}.tar"}
    if include_third_party:
        for zone in sorted(manifest.third_party):
            for name, ref in sorted(manifest.third_party[zone].items()):
                if name in out:
                    raise BundleError(f"이미지 이름이 겹친다: {name}")
                repo, digest = ref.split("@", 1)
                short = digest.split(":", 1)[1][:12]
                out[name] = {"ref": ref, "tag": f"{repo}:jw-{short}", "file": f"{IMAGES_DIR}/{name}.tar"}
    return out


def save_commands(manifest: Manifest, stage: str, include_third_party: bool = False) -> list[list[str]]:
    """이미지를 받아 태그를 붙이고 `stage/images/<이름>.tar` 로 저장하는 명령(실행은 하지 않는다)."""
    out: list[list[str]] = []
    for name, item in image_tags(manifest, include_third_party).items():
        out.append(["docker", "pull", item["ref"]])
        out.append(["docker", "tag", item["ref"], item["tag"]])
        out.append(["docker", "save", "--output", f"{stage}/{item['file']}", item["tag"]])
    return out


def _hash_file(path: Path) -> tuple[int, str]:
    h, size = hashlib.sha256(), 0
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK):
            h.update(chunk)
            size += len(chunk)
    return size, h.hexdigest()


def write_index(stage: Path, created: datetime, include_third_party: bool = False) -> bytes:
    """`stage` 의 manifest·이미지 파일로 `bundle.json` 을 만들어 쓴다(서명은 따로)."""
    for rel in (MANIFEST, MANIFEST + SIG_SUFFIX):
        if not (stage / rel).is_file():
            raise BundleError(f"{rel} 이 없다")
    try:
        manifest = Manifest.from_bytes((stage / MANIFEST).read_bytes())
    except FormatError as e:
        raise BundleError(f"manifest: {e}") from None
    if manifest.offline_bundle is not None:
        raise BundleError("묶음에 넣는 manifest 는 offline_bundle 이 비어 있어야 한다(묶음이 자기 해시를 담을 수 없다)")
    images = image_tags(manifest, include_third_party)
    rels = [MANIFEST, MANIFEST + SIG_SUFFIX] + [item["file"] for item in images.values()]
    files = []
    for rel in sorted(rels):
        path = stage / rel
        if not path.is_file():
            raise BundleError(f"{rel} 이 없다 — 먼저 이미지를 저장한다")
        size, digest = _hash_file(path)
        files.append({"path": rel, "size": size, "sha256": digest})
    index = {
        "format": BUNDLE_FORMAT,
        "version": manifest.version,
        "created": format_time(created),
        "files": files,
        "images": images,
    }
    data = canonical_bytes(index)
    (stage / INDEX).write_bytes(data)
    return data


def member_order(index: dict[str, Any]) -> list[str]:
    """묶음 안의 파일 순서 — 색인과 서명이 맨 앞(큰 이미지를 읽기 전에 서명부터 확인한다)."""
    return [INDEX, INDEX + SIG_SUFFIX] + [f["path"] for f in index["files"]]


def pack(stage: Path, out: Path) -> list[str]:
    """`stage` 를 tar 한 파일로 묶는다(순서·소유자·시각을 고정해 같은 입력이면 같은 파일이 나온다)."""
    for rel in (INDEX, INDEX + SIG_SUFFIX):
        if not (stage / rel).is_file():
            raise BundleError(f"{rel} 이 없다 — 색인을 만들고 서명한 뒤에 묶는다")
    index = _parse_index((stage / INDEX).read_bytes())
    mtime = int(parse_time(index["created"]).timestamp())
    order = member_order(index)
    with tarfile.open(out, "w", format=tarfile.PAX_FORMAT) as tar:
        for rel in order:
            path = stage / rel
            if not path.is_file():
                raise BundleError(f"{rel} 이 없다")
            info = tarfile.TarInfo(rel)
            info.size = path.stat().st_size
            info.mtime = mtime
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with path.open("rb") as f:
                tar.addfile(info, f)
    return order


def _parse_index(data: bytes) -> dict[str, Any]:
    try:
        index = loads(data)
    except FormatError as e:
        raise BundleError(f"{INDEX}: {e}") from None
    if index.get("format") != BUNDLE_FORMAT:
        raise BundleError(f"{INDEX}: 모르는 형식 버전 {index.get('format')!r}")
    files = index.get("files")
    if not isinstance(index.get("version"), str) or not isinstance(index.get("created"), str) or not isinstance(files, list):
        raise BundleError(f"{INDEX}: 항목이 빠졌다")
    seen: set[str] = set()
    for f in files:
        if not isinstance(f, dict) or set(f) != {"path", "size", "sha256"}:
            raise BundleError(f"{INDEX}: 파일 항목 형식이 다르다")
        path = f["path"]
        if not isinstance(path, str) or path.startswith("/") or "\\" in path or ".." in path.split("/") or path in seen:
            raise BundleError(f"{INDEX}: 경로가 올바르지 않다: {path!r}")
        if path in (INDEX, INDEX + SIG_SUFFIX):
            raise BundleError(f"{INDEX}: 색인이 자기 자신을 담을 수 없다")
        seen.add(path)
    if not isinstance(index.get("images"), dict):
        raise BundleError(f"{INDEX}: images 가 없다")
    return index


@dataclass(frozen=True)
class BundleInfo:
    version: str
    manifest: Manifest
    images: dict[str, dict[str, str]]
    files: tuple[str, ...]


def verify_bundle(path: Path, public_keys) -> BundleInfo:
    """묶음 검증(묶음 서명 → manifest → 파일별 해시). 순서는 이 모듈 머리말."""
    try:
        tar = tarfile.open(path, "r:")
    except (tarfile.TarError, OSError) as e:
        raise BundleError(f"묶음을 열지 못했다: {e}") from None
    with tar:
        members: dict[str, tarfile.TarInfo] = {}
        for info in tar:
            if not info.isreg():
                raise BundleError(f"일반 파일이 아닌 항목: {info.name}")
            if info.name in members:
                raise BundleError(f"같은 경로가 두 번 있다: {info.name}")
            members[info.name] = info

        def read(name: str) -> bytes:
            if name not in members:
                raise BundleError(f"{name} 이 없다")
            return tar.extractfile(members[name]).read()

        # 1. 묶음 서명
        index_bytes = read(INDEX)
        try:
            verify.verify_signature(index_bytes, read(INDEX + SIG_SUFFIX), public_keys)
        except verify.VerifyError as e:
            raise BundleError(f"묶음 서명: {e}") from None
        index = _parse_index(index_bytes)
        listed = {f["path"]: f for f in index["files"]}

        # 2. manifest
        for rel in (MANIFEST, MANIFEST + SIG_SUFFIX):
            if rel not in listed:
                raise BundleError(f"색인에 {rel} 이 없다")
        manifest_bytes = read(MANIFEST)
        try:
            verify.verify_file_hash(manifest_bytes, listed[MANIFEST]["sha256"], MANIFEST)
            verify.verify_signature(manifest_bytes, read(MANIFEST + SIG_SUFFIX), public_keys)
            manifest = Manifest.from_bytes(manifest_bytes)
        except (verify.VerifyError, FormatError) as e:
            raise BundleError(f"manifest: {e}") from None
        if manifest.version != index["version"]:
            raise BundleError("색인의 버전이 manifest 와 다르다")
        known = manifest.all_image_refs()
        for name, item in index["images"].items():
            if not isinstance(item, dict) or known.get(name) != item.get("ref"):
                raise BundleError(f"색인의 이미지 {name} 이 manifest 와 다르다")
            if item.get("file") not in listed:
                raise BundleError(f"이미지 {name} 의 파일이 색인에 없다")
        missing = sorted(set(manifest.images) - set(index["images"]))
        if missing:
            raise BundleError(f"묶음에 빠진 이미지: {missing}")

        # 3. 파일별 해시
        extra = sorted(set(members) - set(listed) - {INDEX, INDEX + SIG_SUFFIX})
        if extra:
            raise BundleError(f"색인에 없는 파일: {extra}")
        for rel, item in listed.items():
            if rel not in members:
                raise BundleError(f"{rel} 이 없다")
            h, size = hashlib.sha256(), 0
            src = tar.extractfile(members[rel])
            while chunk := src.read(_CHUNK):
                h.update(chunk)
                size += len(chunk)
            if size != item["size"] or h.hexdigest() != item["sha256"]:
                raise BundleError(f"{rel}: 크기 또는 해시가 다르다")
    return BundleInfo(index["version"], manifest, index["images"], tuple(sorted(listed)))
