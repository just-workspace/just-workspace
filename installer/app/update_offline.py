"""오프라인 업데이트의 준비물 — 묶음 파일과 추가로 필요한 이미지. 계약은 docs/update-api.md 6절.

흐름: 묶음을 올리거나 서버의 경로를 지정 → 검증(묶음 서명 → manifest → 파일별 해시, `jwrelease.bundle.verify_bundle`)
→ 버전 판정(현재보다 높고 한 번에 갈 수 있어야 한다) → 묶음에 들어 있지 않은 남의 이미지 목록 → 그 이미지 파일을
올리면 `docker load` 하고 맞는 이미지인지 본다 → 전부 갖춰지면 적용(`UpdateManager.apply_offline`).

올린 파일은 상태 폴더의 `update/offline/` 에 둔다. 경로로 지정한 묶음은 복사하지 않고 그 자리에서 읽는다.

이미지 파일의 대조: `docker load` 는 레지스트리 다이제스트를 되살리지 못할 수 있다. 그래서 받는 명령이 이미지를
`저장소:jw-<다이제스트 앞 12자>` 로 이름 붙여 저장하게 하고, 들여온 뒤 그 이름(또는 다이제스트 참조)이 있는지 본다.
있어야 할 이름이 생기지 않으면 `hash_mismatch` 다.
"""

from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote

from app import update_release as rel
from app.update_engine import UpdateError, UpdateManager

UPLOAD_MAX = int(os.environ.get("JW_UPDATE_UPLOAD_MAX") or 64 * 1024 ** 3)
ALWAYS = ("postgres", "redis", "nginx", "certbot")
NAMES = {
    "postgres": {"ko": "데이터베이스", "en": "Database"},
    "redis": {"ko": "캐시", "en": "Cache"},
    "nginx": {"ko": "웹 서버", "en": "Web server"},
    "certbot": {"ko": "인증서 발급", "en": "Certificate issuer"},
    "gitea": {"ko": "코드 저장소", "en": "Code hosting"},
    "livekit": {"ko": "회의 서버", "en": "Meeting server"},
    "egress": {"ko": "회의 녹화", "en": "Meeting recorder"},
    "onlyoffice": {"ko": "문서 편집기", "en": "Document editor"},
    "searxng": {"ko": "검색", "en": "Search"},
}


def clean_filename(header: str | None, fallback: str) -> str:
    name = unquote(header or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or len(name) > 255 or any(ord(c) < 32 for c in name):
        return fallback
    return name


class OfflineManager:
    def __init__(self, updates: UpdateManager):
        self.updates = updates
        self.docker = updates.docker
        self.dir: Path = updates.dir / "offline"
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._generation = 0

    # ─── 저장 ───

    def _state(self) -> dict:
        return self.updates._read("offline.json") or {"bundle": None, "images": {}}

    def _save(self, data: dict) -> None:
        self.updates._write("offline.json", data)

    def _patch_bundle(self, generation: int, **changes) -> None:
        with self._lock:
            data = self._state()
            if generation != self._generation or data.get("bundle") is None:
                return
            data["bundle"].update(changes)
            self._save(data)

    def wait(self, timeout: float = 60.0) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    # ─── 묶음 ───

    def _new_bundle(self, source: str, filename: str, path: str, size: int | None, state: str) -> dict:
        with self._lock:
            self._generation += 1
            data = {"bundle": {"source": source, "filename": filename, "path": path, "size_bytes": size,
                               "state": state, "percent": 0 if state == "uploading" else None, "version": None,
                               "current_version": self.updates.current()["version"], "contains": None,
                               "downtime_seconds": None, "error": None, "third_party": {}},
                    "images": {}}
            self._save(data)
            return data

    def receive(self, chunks: Iterable[bytes], filename: str, total: int | None) -> None:
        """올리는 묶음을 파일로 받는다(스트리밍). 다 받으면 검증을 뒤에서 시작한다."""
        self._require_idle()
        if total is not None and total > UPLOAD_MAX:
            raise UpdateError(413, "too_large", limit=UPLOAD_MAX)
        free = self._free()
        if total is not None and free is not None and free < total * 2:
            raise UpdateError(507, "no_space", need=total * 2, free=free)
        self.clear(keep_images=False)
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self.dir / "bundle.tar"
        self._new_bundle("upload", filename, str(path), total, "uploading")
        generation = self._generation
        size = self._write_stream(chunks, path, total, generation, lambda p: self._patch_bundle(generation, percent=p))
        if size is None:
            if generation == self._generation:       # 올리다 끊겼다 — 준비물을 비운다
                self.clear()
            return
        self._patch_bundle(generation, size_bytes=size, state="verifying", percent=None)
        self._start_verify(generation, path)

    def _write_stream(self, chunks: Iterable[bytes], path: Path, total: int | None, generation: int | None,
                      progress) -> int | None:
        size, last = 0, -1
        try:
            with open(path, "wb") as f:
                for chunk in chunks:
                    if generation is not None and generation != self._generation:
                        raise InterruptedError
                    size += len(chunk)
                    if size > UPLOAD_MAX:
                        raise UpdateError(413, "too_large", limit=UPLOAD_MAX)
                    f.write(chunk)
                    if total:
                        percent = min(100, int(size * 100 / total))
                        if percent != last:
                            last = percent
                            progress(percent)
        except InterruptedError:
            path.unlink(missing_ok=True)
            return None
        except OSError as e:
            path.unlink(missing_ok=True)
            if getattr(e, "errno", None) == 28:
                raise UpdateError(507, "no_space", need=total, free=self._free()) from None
            raise
        except UpdateError:
            path.unlink(missing_ok=True)
            raise
        return size

    def _free(self) -> int | None:
        try:
            return shutil.disk_usage(self.updates.paths.data).free
        except OSError:
            return None

    def use_path(self, path_text: str) -> None:
        """서버에 있는 묶음 파일 — 설치 관리자 컨테이너에서 보이는 경로(설치 폴더 = `/data`)여야 한다."""
        self._require_idle()
        self.clear(keep_images=False)
        path = self._container_path(path_text)
        filename = Path(path_text).name or "bundle.tar"
        if path is None or not path.is_file() or not os.access(path, os.R_OK):
            self._new_bundle("path", filename, path_text, None, "file_missing")
            return
        self._new_bundle("path", filename, str(path), path.stat().st_size, "verifying")
        self._start_verify(self._generation, path)

    def _container_path(self, text: str) -> Path | None:
        """호스트의 설치 폴더 아래 경로로 적어도 받는다(`$JW_HOST_DIR/…` → `/data/…`). 데이터 폴더 밖이면 None."""
        paths = self.updates.paths
        host = paths.host_dir.rstrip("/") + "/"
        candidate = Path(str(paths.data) + "/" + text[len(host):]) if text.startswith(host) else Path(text)
        try:
            resolved = candidate.resolve()
            resolved.relative_to(paths.data.resolve())
        except (OSError, ValueError):
            return None
        return resolved

    def _start_verify(self, generation: int, path: Path) -> None:
        if not self.updates.background:
            self._verify(generation, path)
            return
        self._thread = threading.Thread(target=self._verify, args=(generation, path), name="jw-offline-verify",
                                        daemon=True)
        self._thread.start()

    def _verify(self, generation: int, path: Path) -> None:
        import tarfile

        def reject(state: str, code: str, detail: str = "", **more) -> None:
            self._patch_bundle(generation, state=state, percent=None, error={"code": code, "detail": detail[:300]}, **more)

        try:
            keys = rel.load_keys(self.updates.store.dir)
        except rel.verify.VerifyError as e:
            return reject("signature_mismatch", "unconfigured", str(e))
        if not keys:
            return reject("signature_mismatch", "unconfigured", "public key missing")
        try:
            info = rel.jwbundle.verify_bundle(path, keys)
        except rel.jwbundle.BundleError as e:
            text = str(e)
            if text.startswith("묶음 서명") or "서명이" in text:
                return reject("signature_mismatch", "signature", text)
            return reject("invalid", "invalid", text)
        except OSError as e:
            return reject("file_missing", "unreadable", str(e))
        current = self.updates.current()["version"]
        version = info.version
        if not rel.semver.parse(current) < rel.semver.parse(version):
            return reject("version_too_low", "version_too_low", f"{version} <= {current}", version=version)
        low = info.manifest.min_upgrade_from
        if low is not None and rel.semver.parse(current) < rel.semver.parse(low):
            return reject("invalid", "no_upgrade_path", f"min_upgrade_from {low}", version=version)
        try:
            with tarfile.open(path, "r:") as tar:
                raw = tar.extractfile(rel.jwbundle.MANIFEST).read()
                sig = tar.extractfile(rel.jwbundle.MANIFEST + ".sig").read()
        except (OSError, tarfile.TarError, KeyError, AttributeError) as e:
            return reject("invalid", "invalid", str(e))
        self.updates._store_manifest(version, raw, sig)
        missing = {name: ref for zone, m in sorted(info.manifest.third_party.items())
                   for name, ref in sorted(m.items()) if name not in info.images}
        zone_of = {name: zone for zone, m in info.manifest.third_party.items() for name in m}
        self._patch_bundle(generation, state="verified", percent=100, version=version, error=None,
                           contains={"images": True, "apps": [a.kind for a in info.manifest.apps]},
                           downtime_seconds=self.updates.estimate_downtime(1),
                           third_party={n: {"ref": r, "zone": zone_of[n]} for n, r in missing.items()})

    def clear(self, *, keep_images: bool = False) -> None:
        with self._lock:
            self._generation += 1
            data = self._state()
            bundle = data.get("bundle") or {}
            if bundle.get("source") == "upload":
                (self.dir / "bundle.tar").unlink(missing_ok=True)
            self._save({"bundle": None, "images": data.get("images", {}) if keep_images else {}})

    def _require_idle(self) -> None:
        if self.updates.active() is not None:
            raise UpdateError(409, "busy", job=self.updates.active_id())

    # ─── 추가 이미지 ───

    def _present(self, ref: str) -> bool:
        return self.docker.image_exists(ref) or self.docker.image_exists(self.updates.third_party_tag(ref))

    def _rows(self, data: dict) -> list[dict]:
        bundle = data.get("bundle") or {}
        if bundle.get("state") != "verified":
            return []
        services = set(self.updates._services())
        enabled = set(self.updates.enabled_zones())
        catalog = self.updates.catalog
        rows = []
        for name, item in sorted((bundle.get("third_party") or {}).items()):
            ref, zone_id = item["ref"], item["zone"]
            always = zone_id == "core"
            zone_on = always or zone_id in enabled
            needed = name in services if services else zone_on
            uploaded = (data.get("images") or {}).get(name) or {}
            if not needed:
                state = "not_needed"
            elif uploaded.get("state") == "verifying":
                state = "verifying"
            elif self._present(ref):
                state = "present"
            elif uploaded.get("state") == "hash_mismatch":
                state = "hash_mismatch"
            else:
                state = "missing"
            tag = self.updates.third_party_tag(ref)
            zone = None
            if not always and catalog.known(zone_id):
                zone = {"id": zone_id, "name": catalog.get(zone_id)["name"]}
            rows.append({"id": name, "name": NAMES.get(name, {"ko": name, "en": name}),
                         "reason": "always" if always else "zone", "zone": zone, "zone_enabled": zone_on,
                         "state": state, "filename": f"{name}.tar",
                         "command": f"docker pull {ref} && docker tag {ref} {tag} && docker save {tag} -o {name}.tar"})
        return rows

    def receive_image(self, image_id: str, chunks: Iterable[bytes], total: int | None) -> None:
        self._require_idle()
        data = self._state()
        item = ((data.get("bundle") or {}).get("third_party") or {}).get(image_id)
        if (data.get("bundle") or {}).get("state") != "verified" or item is None:
            raise UpdateError(404, "image_unknown")
        if total is not None and total > UPLOAD_MAX:
            raise UpdateError(413, "too_large", limit=UPLOAD_MAX)
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self.dir / f"image-{image_id}.tar"
        self._set_image(image_id, "verifying")
        try:
            self._write_stream(chunks, path, total, None, lambda p: None)
        except Exception:
            self._set_image(image_id, "missing")
            raise
        if not self.updates.background:
            self._load_image(image_id, item["ref"], path)
            return
        thread = threading.Thread(target=self._load_image, args=(image_id, item["ref"], path),
                                  name="jw-offline-load", daemon=True)
        self._thread = thread
        thread.start()

    def _set_image(self, image_id: str, state: str) -> None:
        with self._lock:
            data = self._state()
            data.setdefault("images", {})[image_id] = {"state": state}
            self._save(data)

    def _load_image(self, image_id: str, ref: str, path: Path) -> None:
        try:
            r = self.docker.run(["load", "-i", str(path)], timeout=3600)
            ok = r.ok and self._present(ref)
        finally:
            path.unlink(missing_ok=True)
        self._set_image(image_id, "present" if ok else "hash_mismatch")

    # ─── 조회 · 적용 ───

    def view(self) -> dict:
        data = self._state()
        bundle = data.get("bundle")
        if bundle and bundle.get("state") == "verified" and self.updates.active() is None:
            current = self.updates.current()["version"]
            if not rel.semver.parse(current) < rel.semver.parse(bundle["version"]):
                self.clear()                         # 이미 적용했다 — 준비물을 치운다
                data, bundle = self._state(), None
        rows = self._rows(data)
        blockers = []
        if bundle is None:
            blockers.append("bundle_missing")
        elif bundle["state"] in ("uploading", "verifying"):
            blockers.append("bundle_not_verified")
        elif bundle["state"] != "verified":
            blockers.append("bundle_rejected")
        needed = [r for r in rows if r["state"] != "not_needed"]
        if any(r["state"] == "missing" for r in needed):
            blockers.append("images_missing")
        if any(r["state"] == "verifying" for r in needed):
            blockers.append("images_verifying")
        if any(r["state"] == "hash_mismatch" for r in needed):
            blockers.append("images_mismatch")
        public = None
        if bundle is not None:
            public = {k: bundle.get(k) for k in ("source", "filename", "size_bytes", "state", "percent", "version",
                                                 "current_version", "contains", "downtime_seconds", "error")}
        version = (bundle or {}).get("version")
        available = self.updates.check_raw()["available"]
        wanted = version or (available.get("version") if available.get("state") == "update" else None)
        return {"bundle": public, "images": rows,
                "download_url": rel.offline_download_url(wanted) if wanted else None,
                "accept": ".tar", "ready": not blockers, "blockers": blockers}

    def apply(self, start, actor) -> dict:
        view = self.view()
        if not view["ready"]:
            raise UpdateError(409, "offline_incomplete", blockers=view["blockers"])
        bundle = self._state()["bundle"]
        return self.updates.apply_offline(bundle["version"], bundle["path"], start or "countdown", actor)
