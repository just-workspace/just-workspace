"""업데이트 엔진 — 채널 확인, 적용, 되돌림, 복원 지점, 기록. 계약은 docs/update-api.md.

상태는 전부 상태 폴더의 `update/` 아래에 둔다(설치 관리자·backend 가 다시 떠도 이어진다):

| 파일 | 내용 |
|---|---|
| `settings.json` | 방식·시간대·채널, 시험판 이전 백업, 자동 업데이트 멈춤, 연락처 |
| `check.json` | 마지막 확인의 결과, 채널별 순번, 받을 수 있는 버전 |
| `current.json` | 지금 버전, 적용한 때, 바로 전 버전 |
| `manifests/<버전>.json` + `.sig` | 검증을 통과한 manifest(적용할 때 다시 검증한다) |
| `jobs/<id>.json` · `jobs/<id>.log` | 작업과 그 기록 |
| `active.json` | 진행 중이거나 선택을 기다리는 작업 |
| `history.json` | 기록(365일) |
| `points.json` · `snapshots/<id>/stack/` | 복원 지점과 그때의 스택 파일 |
| `bundles/<버전>/` | 새 설치 관리자 이미지에서 꺼낸 번들 |

적용 단계: preflight → backup → pull → migrate → switch → verify. 되돌림·복원: stop → images → restore_db → start → verify.

**번들과 자기 교체.** 새 버전의 compose·nginx 템플릿·구역 선언은 새 설치 관리자 이미지 안에 있다. `pull` 이 그 이미지를
먼저 받고, `switch` 가 그 이미지의 일회용 컨테이너로 스택 파일을 다시 쓴 다음(`python -m app.update_restack` — 새 버전의
렌더링 코드가 쓴다) 컨테이너를 바꾼다. backend 는 맨 마지막이다. 그 뒤 설치 관리자 자신을 바꾼다: 작업 상태를 디스크에
남기고(`ctx.handoff`), 일회용 보조 컨테이너(`python -m app.update_swap`)가 같은 이름·볼륨·포트·환경으로 새 이미지의
컨테이너를 띄운다. 새 설치 관리자는 기동할 때 작업을 이어받아 `verify` 를 돈다. 교체가 실패하면 보조 컨테이너가 옛
컨테이너를 되살리고, 옛 설치 관리자는 그 단계를 실패로 기록한다(→ 자동 되돌림).
"""

from __future__ import annotations

import json
import random
import re
import secrets
import shutil
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from app import answers as ans
from app import engine as eng
from app import update_release as rel
from app.state import write_private

UPDATE_STEPS = ("preflight", "backup", "pull", "migrate", "switch", "verify")
REVERT_STEPS = ("stop", "images", "restore_db", "start", "verify")
PRE_MIGRATE = ("preflight", "backup", "pull")
COUNTDOWN_SECONDS = 300
KEEP_POINTS = 3                      # 일반 복원 지점(pre-update)은 최근 이만큼만 둔다
RETENTION_DAYS = 365
DEFAULT_DOWNTIME = 240               # 지난 업데이트의 실측이 없을 때의 예상 중단 시간(초, 버전 하나)
CHECK_INTERVAL = 6 * 3600
CHECK_JITTER = 1800
HANDOFF_WAIT = 300
KEEP_RUNNING = ("postgres", "redis", "nginx", "certbot")      # 되돌림의 stop 이 세우지 않는 것
LAST = ("frontend-react", "nginx", "backend")                # switch 에서 맨 뒤에 바꾸는 것(이 순서)
OUR_PREFIX = "just-workspace-"
FLAG_REL = "nginx/state/maintenance.on"
PINS_COMPOSE = "docker-compose.pins.yml"
WINDOW = re.compile(r"([01]\d|2[0-3]):00")
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
MIN_FREE = 1024 ** 3
DEFAULT_PULL_BYTES = 3 * 1024 ** 3


class UpdateError(Exception):
    """API 오류 — `{code, vars}` 로 나간다."""

    def __init__(self, status: int, code: str, /, **vars):
        super().__init__(code)
        self.status, self.code, self.vars = status, code, vars


def fail(cause: str, detail: str = "", **vars) -> eng.StepError:
    return eng.StepError(cause, None, detail=str(detail)[-400:], **vars)


def parse_iso(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def seconds_between(a: str | None, b: str | None) -> int | None:
    if not a or not b:
        return None
    return max(0, int((parse_iso(b) - parse_iso(a)).total_seconds()))


def pull_percent(lines: dict) -> int:
    """`docker pull` 의 줄(계층 id → 마지막 상태)에서 진행률을 어림한다."""
    if not lines:
        return 0
    done = sum(1 for s in lines.values() if s in ("Pull complete", "Already exists"))
    return min(99, int(done * 100 / len(lines)))


def default_post(url: str, headers: dict, body: dict) -> int:
    import httpx

    try:
        with httpx.Client(timeout=5.0) as client:
            return client.post(url, headers=headers, json=body).status_code
    except httpx.HTTPError:
        return 0


class UpdateManager:
    def __init__(self, engine: eng.Engine, *, zones=None, registry: str = "localhost",
                 fetch: Callable[[str], bytes] = rel.http_fetch, post: Callable[[str, dict, dict], int] = default_post,
                 now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
                 sleep: Callable[[float], None] = time.sleep, free_bytes: Callable[[], int | None] | None = None,
                 countdown_seconds: int = COUNTDOWN_SECONDS, background: bool = True):
        self.engine = engine
        self.store = engine.store
        self.docker = engine.docker
        self.paths = engine.paths
        self.catalog = engine.catalog
        self.zones = zones
        self.registry = registry
        self.fetch, self.post, self.now, self.sleep = fetch, post, now, sleep
        self.free_bytes = free_bytes or self._free_bytes
        self.countdown_seconds = countdown_seconds
        self.background = background
        self.dir: Path = self.store.dir / "update"
        self.own_version: str = engine.bundle.version
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._check_thread: threading.Thread | None = None
        self._checking = False
        self._actions: dict[str, str] = {}
        self._tz: tuple[float, int] | None = None

    # ─── 저장 ───

    def _read(self, name: str, default=None):
        return self.store.read(f"update/{name}", default)

    def _write(self, name: str, data) -> None:
        self.store.write(f"update/{name}", data)

    def iso(self, t: datetime | None = None) -> str:
        return rel.utc_iso(t or self.now())

    def settings_raw(self) -> dict:
        data = self._read("settings.json", {}) or {}
        base = {"mode": "manual", "window": {"start": "03:00", "end": "05:00"}, "channel": "stable",
                "beta": {"since": None, "restore_point": None}, "contact": None,
                "auto": {"paused": False, "paused_at": None, "reason": None}, "last_auto": None,
                "auto_skip_until": None, "next_check_at": None}
        return {**base, **data}

    def _save_settings(self, **changes) -> dict:
        with self._lock:
            data = {**self.settings_raw(), **changes}
            self._write("settings.json", data)
            return data

    def current(self) -> dict:
        data = self._read("current.json")
        if not data:
            data = {"version": self.own_version, "applied_at": self.store.install().get("locked_at"),
                    "previous_version": None}
        return data

    def check_raw(self) -> dict:
        return {"last_at": None, "ok": None, "error": None, "sequence": {}, "available": {"state": "none"},
                **(self._read("check.json", {}) or {})}

    def points(self) -> list[dict]:
        return self._read("points.json", []) or []

    def point(self, point_id: str) -> dict | None:
        return next((p for p in self.points() if p["id"] == point_id), None)

    def history_raw(self) -> list[dict]:
        return self._read("history.json", []) or []

    # ─── 작업 저장·조회 ───

    def job_raw(self, job_id: str) -> dict | None:
        if not SAFE_NAME.fullmatch(job_id or ""):
            return None
        return self._read(f"jobs/{job_id}.json")

    def _save(self, job: dict) -> None:
        self._write(f"jobs/{job['id']}.json", job)

    @staticmethod
    def public(job: dict | None) -> dict | None:
        if job is None:
            return None
        return {k: v for k, v in job.items() if k != "ctx"}

    def active_id(self) -> str | None:
        return (self._read("active.json") or {}).get("job")

    def active(self) -> dict | None:
        job_id = self.active_id()
        return self.job_raw(job_id) if job_id else None

    def _set_active(self, job_id: str | None) -> None:
        self._write("active.json", {"job": job_id})

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def wait(self, timeout: float = 60.0) -> None:
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout)

    def log_path(self, job_id: str) -> Path:
        return self.dir / "jobs" / f"{job_id}.log"

    def _logger(self, job: dict, step: str) -> Callable[[str], None]:
        path = self.log_path(job["id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        self.engine.redact.add(*self.store.env_secrets().values())

        def log(text: str) -> None:
            for raw in str(text).splitlines():
                line = self.engine.redact(raw).rstrip()
                if line:
                    with open(path, "a", encoding="utf-8", newline="") as f:
                        f.write(f"{self.iso()} [{step}] {line}\n")
        return log

    def read_log(self, job_id: str, tail: int | None = None) -> list[str]:
        try:
            lines = self.log_path(job_id).read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        return lines[-tail:] if tail else lines

    # ─── 상태·설정 ───

    def settings(self) -> dict:
        s = self.settings_raw()
        point = self.point(s["beta"].get("restore_point") or "")
        return {"mode": s["mode"], "window": s["window"], "channel": s["channel"], "min_age_days": rel.MIN_AGE_DAYS,
                "beta": {"since": s["beta"].get("since"), "restore_point": self.point_public(point) if point else None}}

    @staticmethod
    def point_public(p: dict) -> dict:
        return {"id": p["id"], "kind": p["kind"], "version": p["version"], "created_at": p["created_at"],
                "size_bytes": p.get("size_bytes")}

    def status(self) -> dict:
        s, cur, chk = self.settings_raw(), self.current(), self.check_raw()
        view = self.settings()
        view.pop("beta")
        return {
            "current": {"version": cur["version"], "channel": rel.version_channel(cur["version"]),
                        "applied_at": cur.get("applied_at"), "previous_version": cur.get("previous_version")},
            "settings": view,
            "check": {"state": "checking" if self._checking else "idle", "last_at": chk["last_at"], "ok": chk["ok"],
                      "error": chk["error"]},
            "available": chk["available"],
            "job": self.public(self.active()),
            "auto": s["auto"],
            "last_auto": s["last_auto"],
            "server_time": self.iso(),
        }

    def _require_installed(self) -> None:
        if not self.store.locked:
            raise UpdateError(409, "not_installed")

    def _busy(self) -> None:
        active = self.active()
        if active is not None:
            raise UpdateError(409, "busy", job=active["id"])
        if self.engine.running or (self.zones is not None and getattr(self.zones, "_thread", None) is not None
                                   and self.zones._thread.is_alive()):
            raise UpdateError(409, "busy", job=None)

    def put_settings(self, body: dict) -> tuple[dict, bool]:
        """(응답, 복원을 시작했는가)."""
        self._require_installed()
        s = self.settings_raw()
        errors = []
        changes: dict = {}
        if "mode" in body:
            if body["mode"] in ("manual", "auto"):
                changes["mode"] = body["mode"]
            else:
                errors.append({"field": "mode", "code": "invalid"})
        if "window" in body:
            w = body["window"] if isinstance(body["window"], dict) else {}
            start, end = w.get("start"), w.get("end")
            if not (isinstance(start, str) and isinstance(end, str) and WINDOW.fullmatch(start) and WINDOW.fullmatch(end)):
                errors.append({"field": "window", "code": "invalid"})
            elif start == end:
                errors.append({"field": "window", "code": "window_empty"})
            else:
                changes["window"] = {"start": start, "end": end}
        channel = body.get("channel", s["channel"])
        if channel not in ("stable", "beta"):
            errors.append({"field": "channel", "code": "invalid"})
        stable_return = body.get("stable_return") or "wait"
        if stable_return not in ("wait", "restore"):
            errors.append({"field": "stable_return", "code": "invalid"})
        if errors:
            raise UpdateError(422, "settings_invalid", errors=errors)

        effect = {"channel": None, "wait": None, "job": None}
        started = False
        if channel != s["channel"]:
            if self.active() is not None:
                raise UpdateError(409, "busy", job=self.active_id())
            if channel == "beta":
                changes["channel"] = "beta"
                changes["beta"] = {**s["beta"], "since": s["beta"].get("since") or self.iso()}
                effect["channel"] = "to_beta"
            elif stable_return == "restore":
                point = self.point(s["beta"].get("restore_point") or "")
                if point is None:
                    raise UpdateError(409, "restore_point_missing")
                if changes:
                    self._save_settings(**changes)
                job = self.start_restore(point["id"], body.get("start") or "countdown", body.get("actor"), reason="beta")
                effect.update(channel="to_stable_restore", job=job)
                return {"settings": self.settings(), "effect": effect}, True
            else:
                changes["channel"] = "stable"
                effect["channel"] = "to_stable_wait"
        if changes:
            self._save_settings(**changes)
        if effect["channel"] in ("to_beta", "to_stable_wait"):
            # 채널이 바뀌었다 — 옛 채널의 결과를 지우고 새 채널을 확인한다
            chk = self.check_raw()
            chk["available"] = {"state": "none"}
            self._write("check.json", chk)
            self.check(wait=not self.background or effect["channel"] == "to_stable_wait")
            available = self.check_raw()["available"]
            if effect["channel"] == "to_stable_wait" and available.get("state") == "wait":
                effect["wait"] = {"channel_latest": available.get("channel_latest"),
                                  "resume_from": available.get("resume_from")}
        return {"settings": self.settings(), "effect": effect}, started

    def set_contact(self, contact) -> dict:
        if contact is not None:
            if not isinstance(contact, str) or "\n" in contact or "\r" in contact or len(contact) > 200:
                raise UpdateError(422, "invalid", field="contact")
            contact = contact.strip() or None
        self._save_settings(contact=contact)
        return {"contact": contact}

    def maintenance(self) -> dict:
        job = self.active()
        out = {"active": False, "phase": "idle", "kind": None, "started_at": None, "expected_seconds": None,
               "countdown_ends_at": None, "contact": self.settings_raw().get("contact")}
        if job is None:
            return out
        if job["status"] == "countdown":
            out.update(phase="countdown", kind=job["kind"], expected_seconds=job.get("expected_seconds"),
                       countdown_ends_at=(job.get("countdown") or {}).get("ends_at"))
        elif job["status"] in ("running", "failed"):
            out.update(active=True, phase="running", kind=job["kind"], started_at=job.get("maintenance_started_at"),
                       expected_seconds=job.get("expected_seconds"))
        return out

    def auto_resume(self) -> dict:
        s = self._save_settings(auto={"paused": False, "paused_at": None, "reason": None}, auto_skip_until=None)
        return {"auto": s["auto"], "window": s["window"]}

    # ─── 확인 ───

    def check(self, *, wait: bool = False) -> None:
        """채널을 받아 확인한다(뒤에서). 작업이 도는 중이면 `busy`."""
        if self.active() is not None and self.active()["status"] != "countdown":
            raise UpdateError(409, "busy", job=self.active_id())
        with self._lock:
            if self._checking:
                return
            self._checking = True
        if wait or not self.background:
            self._do_check()
            return
        self._check_thread = threading.Thread(target=self._do_check, name="jw-update-check", daemon=True)
        self._check_thread.start()

    def _do_check(self) -> None:
        try:
            self._check_once()
        except Exception as e:  # noqa: BLE001 — 확인 실패가 서버를 멈추면 안 된다
            chk = self.check_raw()
            chk.update(last_at=self.iso(), ok=False, error={"code": "channel_invalid", "detail": type(e).__name__})
            self._write("check.json", chk)
        finally:
            self._checking = False
            self._save_settings(next_check_at=self.iso(
                self.now() + timedelta(seconds=CHECK_INTERVAL + random.randint(0, CHECK_JITTER))))

    def _check_once(self) -> None:
        chk = self.check_raw()
        s = self.settings_raw()
        channel_name = s["channel"]
        current = self.current()["version"]
        try:
            try:
                keys = rel.load_keys(self.store.dir)
            except rel.verify.VerifyError as e:
                raise rel.CheckError("unconfigured") from None
            result = rel.check_channel(current=current, channel_name=channel_name, keys=keys,
                                       last_sequence=chk["sequence"].get(channel_name), now=self.now(), fetch=self.fetch)
        except rel.CheckError as e:
            chk.update(last_at=self.iso(), ok=False, error=e.as_dict())
            if e.code == "unconfigured":
                chk["available"] = {"state": "none"}
            self._write("check.json", chk)
            return
        for version, (raw, sig) in result.manifests.items():
            self._store_manifest(version, raw, sig)
        chk["sequence"][channel_name] = result.channel.sequence
        chk.update(last_at=self.iso(), ok=True, error=None, available=self._available(result))
        self._write("check.json", chk)
        self._after_check(current)

    def _store_manifest(self, version: str, raw: bytes, sig: bytes) -> None:
        folder = self.dir / "manifests"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{version}.json").write_bytes(raw)
        (folder / f"{version}.json.sig").write_bytes(sig if isinstance(sig, bytes) else str(sig).encode())

    def manifest(self, version: str) -> rel.Manifest:
        """저장해 둔 manifest — 쓸 때마다 서명을 다시 확인한다."""
        folder = self.dir / "manifests"
        try:
            raw = (folder / f"{version}.json").read_bytes()
            sig = (folder / f"{version}.json.sig").read_bytes()
        except OSError:
            raise fail("manifest_missing", version=version) from None
        try:
            keys = rel.load_keys(self.store.dir)
            rel.verify.verify_signature(raw, sig, keys)
            manifest = rel.Manifest.from_bytes(raw)
        except (rel.verify.VerifyError, rel.FormatError) as e:
            raise fail("manifest_invalid", str(e), version=version) from None
        if manifest.version != version:
            raise fail("manifest_invalid", "version mismatch", version=version)
        return manifest

    def manifest_or_none(self, version: str) -> rel.Manifest | None:
        try:
            return self.manifest(version)
        except eng.StepError:
            return None

    def enabled_zones(self) -> list[str]:
        return ans.selected_zones(self.store.load_answers(), self.catalog)

    def estimate_downtime(self, versions: int = 1) -> int:
        """예상 중단 시간 — 지난 업데이트의 실측(없으면 기본 추정값) × 거칠 버전 수."""
        for item in self.history_raw():
            if item["kind"] == "update" and item["result"] == "success" and item.get("downtime_seconds"):
                per = item["downtime_seconds"] / max(1, len(item.get("versions") or [1]))
                return int(per * max(1, versions))
        return DEFAULT_DOWNTIME * max(1, versions)

    def changed_zones(self, manifest: rel.Manifest) -> list[dict]:
        """이미지가 바뀌는 구역 중 켜진 것. 우리 이미지는 버전마다 새로 빌드되므로, 우리 이미지를 쓰는 구역은 늘 바뀐다."""
        try:
            compose_text = (self.paths.stack / "docker-compose.yml").read_text(encoding="utf-8")
        except OSError:
            compose_text = ""
        out = []
        for zone_id in ("core", *self.enabled_zones()):
            zone = self.catalog.get(zone_id)
            ours = any(svc in manifest.images for svc in zone.get("services", []))
            third = any(ref.split("@", 1)[1] not in compose_text for ref in manifest.third_party.get(zone_id, {}).values())
            if ours or third:
                out.append({"id": zone_id, "name": zone["name"]})
        return out

    def plugin_warnings(self, manifest: rel.Manifest) -> list[dict]:
        """새 버전과 맞는지 확인되지 않은 플러그인. manifest 의 `plugin_api` 가 비어 있으면 판정하지 않는다(빈 목록)."""
        if not manifest.plugin_api:
            return []
        out = []
        api = str(manifest.plugin_api.get("version") or "")
        try:
            folders = sorted(p for p in (self.paths.stack / "plugins").iterdir() if p.is_dir())
        except OSError:
            folders = []
        for folder in folders:
            try:
                meta = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                meta = {}
            supported = meta.get("plugin_api")
            versions = supported if isinstance(supported, list) else [supported] if supported else []
            if api and api in [str(v) for v in versions]:
                continue
            out.append({"id": folder.name, "name": str(meta.get("name") or folder.name), "reason": "unverified"})
        return out

    def _available(self, result: rel.CheckResult) -> dict:
        plan = result.plan
        if plan.action == rel.verify.ACTION_CURRENT:
            return {"state": "none"}
        if plan.action == rel.verify.ACTION_WAIT:
            return {"state": "wait", "channel_latest": plan.target, "resume_from": rel.resume_from(plan.current)}
        if plan.action == rel.verify.ACTION_BLOCKED:
            entry = result.channel.find(plan.target)
            return {"state": "blocked", "version": plan.target,
                    "reason": {"code": "no_upgrade_path", "vars": {"min_upgrade_from": entry.min_upgrade_from}}}
        entry = result.channel.find(plan.target)
        manifests = [rel.Manifest.from_bytes(result.manifests[v][0]) for v in plan.path]
        sizes = [getattr(m, "download_bytes", None) for m in manifests]
        target = manifests[-1]
        return {
            "state": "update", "version": plan.target, "channel": rel.version_channel(plan.target),
            "published": entry.published, "summary": entry.summary, "path": list(plan.path),
            "download_bytes": sum(sizes) if all(isinstance(x, int) for x in sizes) else None,
            "downtime_seconds": self.estimate_downtime(len(plan.path)),
            "zones": self.changed_zones(target), "plugin_warnings": self.plugin_warnings(target),
            "changelog": target.changelog, "auto_eligible_at": rel.auto_eligible_at(entry.published),
        }

    def _after_check(self, current: str) -> None:
        """Stable 로 돌아와 Stable 이 현재 버전 이상이 됐으면 시험판 이전 백업을 지운다."""
        s = self.settings_raw()
        beta_point = s["beta"].get("restore_point")
        if s["channel"] == "stable" and rel.semver.is_stable(current) and (beta_point or s["beta"].get("since")):
            if beta_point:
                self._drop_point(beta_point)
            self._save_settings(beta={"since": None, "restore_point": None})

    # ─── 주기 작업(확인 · 자동 적용) ───

    def server_offset(self) -> int:
        """서버 시간의 UTC 차(초). 호스트의 시간대를 보조 컨테이너로 읽는다(한 시간 기억)."""
        if self._tz is not None and time.monotonic() - self._tz[0] < 3600:
            return self._tz[1]
        offset = None
        image = self.docker.self_image()
        if image:
            r = self.docker.run(["run", "--rm", "--network", "none", "-v", "/etc/localtime:/etc/localtime:ro",
                                 "--entrypoint", "python", image, "-c",
                                 "import time;print(time.localtime().tm_gmtoff)"], timeout=60)
            try:
                offset = int(r.out.strip().splitlines()[-1]) if r.ok else None
            except (ValueError, IndexError):
                offset = None
        if offset is None:
            offset = time.localtime().tm_gmtoff or 0
        self._tz = (time.monotonic(), offset)
        return offset

    def local_minutes(self) -> int:
        local = self.now() + timedelta(seconds=self.server_offset())
        return local.hour * 60 + local.minute

    def auto_due(self) -> str | None:
        """지금 자동 적용을 시작해도 되는가 — 되면 목표 버전, 아니면 None."""
        s = self.settings_raw()
        available = self.check_raw()["available"]
        if s["mode"] != "auto" or s["auto"]["paused"] or not self.store.locked:
            return None
        if available.get("state") != "update" or self.active() is not None:
            return None
        if self.now() < parse_iso(available["auto_eligible_at"]):
            return None
        if s.get("auto_skip_until") and self.now() < parse_iso(s["auto_skip_until"]):
            return None
        if not rel.in_window(s["window"]["start"], s["window"]["end"], self.local_minutes()):
            return None
        return available["version"]

    def tick(self) -> None:
        """한 분마다 불린다 — 확인할 때가 됐으면 확인하고, 자동 적용 조건이 맞으면 예고를 연다."""
        if not self.store.locked:
            return
        s = self.settings_raw()
        active = self.active()
        if active is None or active["status"] == "countdown":
            due = s.get("next_check_at")
            if not due or self.now() >= parse_iso(due):
                try:
                    self.check()
                except UpdateError:
                    pass
        target = self.auto_due()
        if target:
            try:
                self.apply(target, "countdown", None, trigger="auto")
            except UpdateError:
                pass
        self.prune_history()

    # ─── 작업 만들기 ───

    def _new_job(self, kind: str, trigger: str, *, from_version, target_version, path, steps, actor, start: str,
                 expected: int | None, **extra) -> dict:
        job = {
            "id": secrets.token_hex(8), "kind": kind, "trigger": trigger, "status": "running",
            "from_version": from_version, "target_version": target_version, "path": list(path), "version_index": 0,
            "countdown": None, "steps": [{"id": s, "status": "pending"} for s in steps], "error": None, "choices": [],
            "rollback_job": None, "restore": None, "expected_seconds": expected, "started_at": self.iso(),
            "maintenance_started_at": None, "finished_at": None, "actor": actor if isinstance(actor, dict) else None,
            "ctx": {},
        }
        job.update(extra)
        if start == "countdown" and self.countdown_seconds > 0:
            job["status"] = "countdown"
            job["countdown"] = {"ends_at": self.iso(self.now() + timedelta(seconds=self.countdown_seconds)),
                                "seconds": self.countdown_seconds}
        return job

    def _launch(self, job: dict) -> dict:
        if self._read("current.json") is None:
            self._write("current.json", self.current())      # 설치 관리자가 바뀌어도 "지금 버전"이 흔들리지 않게 적어 둔다
        self._save(job)
        self._set_active(job["id"])
        if job["kind"] != "rollback":
            self._history_open(job)
        self._spawn(job["id"])
        return self.public(self.job_raw(job["id"]))

    def _spawn(self, job_id: str) -> None:
        if not self.background:
            self._run(job_id)
            return
        self._thread = threading.Thread(target=self._run, args=(job_id,), name="jw-update", daemon=True)
        self._thread.start()

    def apply(self, target, start, actor, *, trigger: str = "manual") -> dict:
        self._require_installed()
        if start not in ("countdown", "now"):
            raise UpdateError(422, "invalid", field="start")
        with self._lock:
            self._busy()
            available = self.check_raw()["available"]
            if available.get("state") != "update":
                raise UpdateError(409, "not_available")
            if target != available["version"]:
                raise UpdateError(409, "target_stale", target=available["version"])
            job = self._new_job("update", trigger, from_version=self.current()["version"], target_version=target,
                                path=available["path"], steps=UPDATE_STEPS, actor=actor, start=start,
                                expected=available.get("downtime_seconds"))
            return self._launch(job)

    def apply_offline(self, version: str, bundle_path: str, start, actor) -> dict:
        self._require_installed()
        if start not in ("countdown", "now"):
            raise UpdateError(422, "invalid", field="start")
        with self._lock:
            self._busy()
            job = self._new_job("update", "offline", from_version=self.current()["version"], target_version=version,
                                path=[version], steps=UPDATE_STEPS, actor=actor, start=start,
                                expected=self.estimate_downtime(1))
            job["ctx"]["bundle"] = bundle_path
            return self._launch(job)

    def start_restore(self, point_id, start, actor, *, reason: str = "manual") -> dict:
        self._require_installed()
        if start not in ("countdown", "now"):
            raise UpdateError(422, "invalid", field="start")
        with self._lock:
            point = self.point(point_id if isinstance(point_id, str) else "")
            if point is None:
                raise UpdateError(404, "restore_point_unknown")
            self._busy()
            job = self._new_job("restore", "manual", from_version=self.current()["version"],
                                target_version=point["version"], path=[point["version"]], steps=REVERT_STEPS,
                                actor=actor, start=start, expected=self.estimate_downtime(1),
                                restore={"point": point["id"], "version": point["version"], "reason": reason})
            job["ctx"].update(point=point["id"], need_db=True, light=False)
            return self._launch(job)

    def _new_rollback(self, parent: dict) -> dict:
        ctx = parent["ctx"]
        index = parent["version_index"]
        back_to = parent["from_version"] if index == 0 else parent["path"][index - 1]
        job = self._new_job("rollback", parent["trigger"], from_version=parent["path"][index], target_version=back_to,
                            path=[back_to], steps=REVERT_STEPS, actor=parent.get("actor"), start="now",
                            expected=parent.get("expected_seconds"), parent_job=parent["id"])
        job["maintenance_started_at"] = parent.get("maintenance_started_at")
        job["ctx"].update(point=ctx.get("point"), need_db=bool(ctx.get("migrate_started")),
                          light=not ctx.get("switch_started") and not ctx.get("migrate_started"))
        return job

    def action(self, job_id: str, action, actor) -> dict:
        with self._lock:
            job = self.job_raw(job_id)
            if job is None:
                raise UpdateError(404, "job_unknown")
            allowed = ["start_now", "cancel"] if job["status"] == "countdown" else list(job.get("choices") or [])
            if action not in allowed or (self.running and job["status"] != "countdown"):
                raise UpdateError(409, "action_not_allowed", status=job["status"], allowed=allowed)
            if action in ("start_now", "cancel"):
                self._actions[job_id] = action
                if not self.running:           # 예고 중에 설치 관리자가 다시 떴다 — 스레드가 없으면 여기서 잇는다
                    self._spawn(job_id)
                elif not self.background:
                    pass
                return self._settled(job_id, lambda j: j["status"] != "countdown")
            if action == "retry":
                for step in job["steps"]:
                    if step["status"] == "failed":
                        step.update(status="pending", started_at=None, finished_at=None)
                job.update(status="running", error=None, choices=[], finished_at=None)
                self._save(job)
                self._spawn(job_id)
                return self.public(self.job_raw(job_id))
            # rollback
            rb = self._new_rollback(job)
            job.update(choices=[], rollback_job=rb["id"])
            self._save(job)
            self._save(rb)
            self._set_active(rb["id"])
            self._spawn(rb["id"])
            return self.public(self.job_raw(job_id))

    def _settled(self, job_id: str, done: Callable[[dict], bool], timeout: float = 5.0) -> dict:
        """예고 제어의 응답 — 스레드가 상태를 바꿀 때까지 잠깐 기다렸다가 돌려준다."""
        waited = 0.0
        while self.background and waited < timeout:
            job = self.job_raw(job_id)
            if job is None or done(job):
                break
            time.sleep(0.1)
            waited += 0.1
        return self.public(self.job_raw(job_id))

    # ─── 알림 · 점검 모드 ───

    def notify(self, event: dict) -> None:
        """backend 에 예고·점검을 알린다. 못 보내도 작업은 계속한다(backend 가 다시 뜨는 중일 수 있다)."""
        key = self.store.env_secrets().get("JW_INSTALLER_KEY", "")
        if not key:
            return
        for attempt in range(3):
            if self.post("http://backend:8000/api/internal/system/update-event",
                         {"X-JW-Installer-Key": key}, event) == 200:
                return
            if attempt < 2:
                self.sleep(2)

    def flag_path(self) -> Path:
        return self.paths.stack / FLAG_REL

    def set_maintenance(self, on: bool) -> None:
        """nginx 점검 모드 — 표식 파일이 있으면 nginx 가 일반 요청을 503 으로 막는다(nginx.conf). 다시 읽힐 필요가 없다."""
        path = self.flag_path()
        try:
            if on:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.parent.chmod(0o755)
                path.write_text(self.iso() + "\n", encoding="utf-8")
                path.chmod(0o644)
            else:
                path.unlink(missing_ok=True)
        except OSError:
            pass

    def _begin_maintenance(self, job: dict) -> None:
        job.update(status="running", countdown=None, maintenance_started_at=job.get("maintenance_started_at") or self.iso())
        self._save(job)
        self.notify({"type": "maintenance", "job": job["id"], "kind": job["kind"],
                     "started_at": job["maintenance_started_at"], "expected_seconds": job.get("expected_seconds")})
        self.set_maintenance(True)

    def _end_maintenance(self, job: dict, result: str, *, version, from_version, failed_step=None,
                         trigger: str | None = None) -> int | None:
        downtime = seconds_between(job.get("maintenance_started_at"), job.get("finished_at"))
        self.set_maintenance(False)
        self.notify({"type": "finished", "job": job["id"], "kind": job["kind"], "trigger": trigger or job["trigger"],
                     "result": result, "version": version, "from_version": from_version, "failed_step": failed_step,
                     "downtime_seconds": downtime})
        return downtime

    # ─── 실행 ───

    def _run(self, job_id: str) -> None:
        job = self.job_raw(job_id)
        if job is None:
            return
        try:
            if job["status"] == "countdown":
                if not self._countdown(job):
                    return
            elif not job.get("maintenance_started_at"):
                self._begin_maintenance(job)
            if job["kind"] == "update":
                self._run_update(job)
            else:
                self._run_revert(job)
        except Exception as e:  # noqa: BLE001 — 예상 못 한 오류도 작업 실패로 남긴다
            self._logger(job, "engine")(f"예상하지 못한 오류: {type(e).__name__}: {str(e)[:300]}")
            job = self.job_raw(job_id) or job
            running = next((s for s in job["steps"] if s["status"] == "running"), None)
            if running is None:
                running = next((s for s in job["steps"] if s["status"] == "pending"), job["steps"][-1])
            error = fail("unexpected_error", type=type(e).__name__)
            if job["kind"] == "update":
                self._update_failed(job, running, error)
            else:
                self._revert_failed(job, running, error)

    def _countdown(self, job: dict) -> bool:
        self.notify({"type": "countdown", "job": job["id"], "kind": job["kind"], "trigger": job["trigger"],
                     "ends_at": job["countdown"]["ends_at"], "expected_seconds": job.get("expected_seconds")})
        ends = parse_iso(job["countdown"]["ends_at"])
        while True:
            action = self._actions.pop(job["id"], None)
            if action == "cancel":
                job.update(status="cancelled", countdown=None, finished_at=self.iso())
                self._save(job)
                self._set_active(None)
                self.notify({"type": "cancelled", "job": job["id"]})
                self._history_close(job, "cancelled", version=job["from_version"])
                if job["trigger"] == "auto":
                    # 이 시간대는 건너뛴다(멈춤은 아니다)
                    self._save_settings(auto_skip_until=self.iso(self.now() + timedelta(hours=self._window_hours())))
                return False
            if action == "start_now" or self.now() >= ends:
                break
            self.sleep(1)
        self._begin_maintenance(job)
        return True

    def _window_hours(self) -> int:
        w = self.settings_raw()["window"]
        a, b = int(w["start"][:2]), int(w["end"][:2])
        return (b - a) % 24 or 24

    def _step(self, job: dict, step: dict, funcs: dict) -> eng.StepError | None:
        log = self._logger(job, step["id"])
        step.update(status="running", started_at=self.iso(), finished_at=None)
        step.setdefault("detail", {})
        self._save(job)
        log("시작")
        try:
            funcs[step["id"]](job, step, log)
        except eng.StepError as e:
            log(f"실패: {e.cause} {e.vars.get('detail') or ''}")
            return e
        except Exception as e:  # noqa: BLE001
            log(f"실패(예상하지 못한 오류): {type(e).__name__}: {self.engine.redact(str(e))[:300]}")
            return fail("unexpected_error", type=type(e).__name__)
        step.update(status="done", finished_at=self.iso())
        self._save(job)
        log("완료")
        return None

    def _run_update(self, job: dict) -> None:
        funcs = {"preflight": self.step_preflight, "backup": self.step_backup, "pull": self.step_pull,
                 "migrate": self.step_migrate, "switch": self.step_switch, "verify": self.step_verify}
        while True:
            for step in job["steps"]:
                if step["status"] == "done":
                    continue
                error = self._step(job, step, funcs)
                if error is not None:
                    self._update_failed(job, step, error)
                    return
            version = job["path"][job["version_index"]]
            self._version_done(job, version)
            if job["version_index"] + 1 >= len(job["path"]):
                break
            job["version_index"] += 1
            job["steps"] = [{"id": s, "status": "pending"} for s in UPDATE_STEPS]
            job["ctx"] = {k: v for k, v in job["ctx"].items() if k in ("bundle", "versions")}
            self._save(job)
        self._finish_update(job)

    def _snapshot_steps(self, job: dict) -> list[dict]:
        out = []
        for step in job["steps"]:
            note = None
            if step["status"] == "failed" and job.get("error"):
                note = job["error"].get("detail") or job["error"].get("cause")
            out.append({"id": step["id"], "status": step["status"],
                        "duration_seconds": seconds_between(step.get("started_at"), step.get("finished_at")),
                        "note": note})
        return out

    def _record_version(self, job: dict) -> None:
        version = job["path"][job["version_index"]]
        versions = [v for v in job["ctx"].setdefault("versions", []) if v["version"] != version]
        versions.append({"version": version, "steps": self._snapshot_steps(job)})
        job["ctx"]["versions"] = versions

    def _version_done(self, job: dict, version: str) -> None:
        stored = self._read("current.json")       # 파일이 없을 때의 기본값은 설치 관리자 자신의 버전이라 여기서는 못 쓴다
        index = job["version_index"]
        if not stored or stored.get("version") != version:
            self._write("current.json", {"version": version, "applied_at": self.iso(),
                                         "previous_version": job["from_version"] if index == 0 else job["path"][index - 1]})
        self._record_version(job)
        self._save(job)

    def _update_failed(self, job: dict, step: dict, error: eng.StepError) -> None:
        step.update(status="failed", finished_at=self.iso())
        detail = error.vars.get("detail") or ""
        job.update(status="failed", finished_at=self.iso(),
                   error={"step": step["id"], "cause": error.cause, "detail": detail,
                          "vars": {k: v for k, v in error.vars.items() if k != "detail"}})
        self._record_version(job)
        automatic = job["trigger"] == "auto" or step["id"] not in PRE_MIGRATE
        if not automatic:
            job["choices"] = ["retry", "rollback"]
            self._save(job)
            self._history_update(job["id"], versions=job["ctx"]["versions"])
            return
        rb = self._new_rollback(job)
        job.update(choices=[], rollback_job=rb["id"])
        self._save(job)
        self._save(rb)
        self._set_active(rb["id"])
        self._history_update(job["id"], versions=job["ctx"]["versions"])
        self._run_revert(rb)

    def _finish_update(self, job: dict) -> None:
        job.update(status="done", finished_at=self.iso(), error=None, choices=[])
        self._save(job)
        self._set_active(None)
        downtime = self._end_maintenance(job, "success", version=job["target_version"],
                                         from_version=job["from_version"])
        self._history_close(job, "success", version=job["target_version"], downtime=downtime,
                            versions=job["ctx"].get("versions"))
        if job["trigger"] == "auto":
            self._save_settings(last_auto={"job": job["id"], "result": "success", "version": job["target_version"],
                                           "from_version": job["from_version"], "finished_at": job["finished_at"],
                                           "downtime_seconds": downtime, "failed_step": None})
        chk = self.check_raw()
        if (chk["available"] or {}).get("version") == job["target_version"]:
            chk["available"] = {"state": "none"}
            self._write("check.json", chk)
        self.prune_points()
        self._after_check(job["target_version"])

    # ─── 적용 단계 ───

    def _free_bytes(self) -> int | None:
        values = []
        try:
            values.append(shutil.disk_usage(self.paths.data).free)
        except OSError:
            pass
        r = self.docker.helper(["disk", "/probe"], volumes=["/probe"], timeout=60)
        got = eng.helper_json(r).get("free_bytes")
        if isinstance(got, int):
            values.append(got)
        return min(values) if values else None

    def schema_status(self) -> dict:
        r = self.docker.exec("ws-backend", ["python", "-m", "app.cli", "migrate", "--status", "--json"], timeout=120)
        try:
            return json.loads(r.out) if r.out.strip() else {}
        except ValueError:
            return {}

    def step_preflight(self, job: dict, step: dict, log) -> None:
        version = job["path"][job["version_index"]]
        manifest = self.manifest(version)
        if "installer" not in manifest.images or "backend" not in manifest.images:
            raise fail("manifest_incomplete", version=version)
        if self.engine.running or (self.zones is not None and getattr(self.zones, "_thread", None) is not None
                                   and self.zones._thread.is_alive()):
            raise fail("other_job_running")
        if not self.docker.container_status("ws-backend")["running"]:
            raise fail("backend_not_running")
        need = 2 * (getattr(manifest, "download_bytes", None) or DEFAULT_PULL_BYTES) + MIN_FREE
        if job["trigger"] == "offline":
            need = MIN_FREE * 4
        free = self.free_bytes()
        if free is not None and free < need:
            raise fail("no_space", need=need, free=free)
        schema = self.schema_status()
        current_schema = schema.get("current")
        target_schema = manifest.db_schema if isinstance(manifest.db_schema, int) else None
        if isinstance(current_schema, int) and target_schema is not None and target_schema < current_schema:
            raise fail("schema_downgrade", current=current_schema, target=target_schema)
        warnings = self.plugin_warnings(manifest)
        step["detail"].update(schema={"current": current_schema, "target": target_schema,
                                      "changes": bool(target_schema and current_schema and target_schema > current_schema)},
                              plugin_warnings=warnings, free_bytes=free)
        log(f"{version}: manifest 검증 통과, 스키마 {current_schema} → {target_schema if target_schema is not None else '?'}, "
            f"여유 공간 {free}")

    def _stack_snapshot(self, point_id: str) -> str:
        dest = self.dir / "snapshots" / point_id / "stack"
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(self.paths.stack, dest, symlinks=True,
                        ignore=lambda folder, names: [n for n in names
                                                      if Path(folder) == self.paths.stack and n == "plugins"])
        (dest / FLAG_REL).unlink(missing_ok=True)
        return str(dest)

    def step_backup(self, job: dict, step: dict, log) -> None:
        version = job["path"][job["version_index"]]
        from_version = self.current()["version"]
        r = self.docker.exec("ws-backend", ["python", "-m", "app.cli", "backup", "create", "--kind", "pre-update", "--json"],
                             timeout=3600)
        log(r.err[-1500:])
        try:
            info = json.loads(r.out)
        except ValueError:
            info = {}
        if r.rc not in (0, 2) or not info.get("path") or "db" not in (info.get("items") or []):
            raise fail("backup_failed", r.err or r.out, exit_code=r.rc)
        points = self.points()
        s = self.settings_raw()
        kind = "pre-update"
        if rel.semver.is_stable(from_version) and rel.semver.is_beta(version) and not s["beta"].get("restore_point"):
            kind = "pre-beta"        # Beta 로 처음 올리기 직전 — 따로 보관한다
        point = {"id": "rp-" + self.now().strftime("%Y%m%d%H%M%S") + "-" + secrets.token_hex(2), "kind": kind,
                 "version": from_version, "created_at": self.iso(), "size_bytes": info.get("size_bytes"),
                 "backup": info["path"], "schema_version": info.get("schema_version"), "job": job["id"],
                 "installer_image": self.docker.self_image()}
        point["snapshot"] = self._stack_snapshot(point["id"])
        self._write("points.json", [point, *points])
        if kind == "pre-beta":
            self._save_settings(beta={"since": s["beta"].get("since") or self.iso(), "restore_point": point["id"]})
        job["ctx"]["point"] = point["id"]
        step["detail"].update(point=point["id"], path=info["path"], size_bytes=info.get("size_bytes"))
        log(f"백업 {info['path']} ({info.get('size_bytes')} 바이트) — 복원 지점 {point['id']}({kind})")

    def local_tag(self, name: str, version: str) -> str:
        return f"{self.registry}/{OUR_PREFIX}{name}:{version}"

    def bundle_dir(self, version: str) -> Path:
        return self.dir / "bundles" / version

    def _pull_one(self, row: dict, ref: str, log, save) -> None:
        if self.docker.image_exists(ref):
            row.update(status="done", percent=100)
            save()
            return
        row.update(status="pulling", percent=0)
        save()
        layers: dict[str, str] = {}
        last = [0.0]

        def on_line(line: str) -> None:
            head, sep, tail = line.partition(": ")
            if sep and re.fullmatch(r"[0-9a-f]{12}", head):
                layers[head] = tail.strip()
                row["percent"] = pull_percent(layers)
                if time.monotonic() - last[0] > 1.0:
                    last[0] = time.monotonic()
                    save()

        r = self.docker.pull(ref, on_line=on_line)
        if not r.ok:
            row["status"] = "failed"
            save()
            log(r.err[-500:])
            raise fail("image_pull_failed", r.err, image=row["name"])
        row.update(status="done", percent=100)
        save()

    def _load_from_bundle(self, bundle_path: str, member: str, log) -> None:
        import tarfile

        tmp = self.dir / "tmp" / (secrets.token_hex(6) + ".tar")
        tmp.parent.mkdir(parents=True, exist_ok=True)
        try:
            with tarfile.open(bundle_path, "r:") as tar, tar.extractfile(member) as src, open(tmp, "wb") as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
            r = self.docker.run(["load", "-i", str(tmp)], timeout=3600)
            if not r.ok:
                raise fail("image_load_failed", r.err, image=member)
        except (OSError, tarfile.TarError, KeyError) as e:
            raise fail("image_load_failed", str(e), image=member) from None
        finally:
            tmp.unlink(missing_ok=True)

    def third_party_tag(self, ref: str) -> str:
        repo, digest = ref.split("@", 1)
        return f"{repo}:jw-{digest.split(':', 1)[1][:12]}"

    def _extract_bundle(self, version: str, image: str, log) -> None:
        dest = self.bundle_dir(version)
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        host = f"{self.paths.host_dir.rstrip('/')}/state/update/bundles/{version}"
        r = self.docker.run(["run", "--rm", "--network", "none", "--entrypoint", "sh", "-v", f"{host}:/out", image,
                             "-c", "cp -a /app/bundle/. /out/"], timeout=120)
        if not r.ok or not (dest / "docker-compose.yml").exists():
            raise fail("bundle_extract_failed", r.err)
        log(f"새 번들을 꺼냈습니다: {dest}")

    def _services(self, compose_file: Path | None = None) -> list[str]:
        """지금 프로파일에서 켜지는 compose 서비스. compose_file 을 주면 그 파일(새 번들)로 본다."""
        if compose_file is None:
            r = self.docker.compose("config", "--services", timeout=60)
        else:
            prefix = self.docker.compose_prefix()
            index = prefix.index("-f") + 1
            prefix[index] = compose_file.as_posix()
            r = self.docker.run([*prefix, "config", "--services"], timeout=60)
        return [line.strip() for line in r.out.splitlines() if line.strip()] if r.ok else []

    def needed_images(self, manifest: rel.Manifest, services: list[str]) -> tuple[list[str], dict[str, str]]:
        """(받을 우리 이미지 이름, 받을 남의 이미지 이름 → 참조). 설치 관리자가 맨 앞."""
        active = set(services)
        ours = ["installer"] + [n for n in sorted(manifest.images)
                                if n != "installer" and (n in active or (n == "rbi-mirror" and "rbi-netfilter" in active))]
        third = {name: ref for zone in sorted(manifest.third_party)
                 for name, ref in sorted(manifest.third_party[zone].items()) if name in active}
        return ours, third

    def step_pull(self, job: dict, step: dict, log) -> None:
        version = job["path"][job["version_index"]]
        manifest = self.manifest(version)
        bundle_path = job["ctx"].get("bundle")
        index = None
        if bundle_path:
            try:
                index = rel.jwbundle.verify_bundle(Path(bundle_path), rel.load_keys(self.store.dir))
            except (rel.jwbundle.BundleError, rel.verify.VerifyError, OSError) as e:
                raise fail("bundle_invalid", str(e)) from None
        rows = [{"name": "installer", "status": "pending", "percent": 0}]
        step["detail"]["images"] = rows
        save = lambda: self._save(job)  # noqa: E731
        save()

        def ours(name: str, row: dict) -> None:
            tag = self.local_tag(name, version)
            if index is not None:
                item = index.images[name]
                row.update(status="pulling", percent=0)
                save()
                if not self.docker.image_exists(item["tag"]):
                    self._load_from_bundle(bundle_path, item["file"], log)
                source = item["tag"]
                if not self.docker.image_exists(source):
                    row["status"] = "failed"
                    save()
                    raise fail("image_load_failed", "tag missing after load", image=name)
                row.update(status="done", percent=100)
                save()
            else:
                source = manifest.images[name]
                self._pull_one(row, source, log, save)
            if source != tag:
                r = self.docker.run(["tag", source, tag], timeout=60)
                if not r.ok:
                    raise fail("image_tag_failed", r.err, image=name)

        ours("installer", rows[0])
        self._extract_bundle(version, self.local_tag("installer", version), log)
        services = self._services(self.bundle_dir(version) / "docker-compose.yml") or self._services()
        names, third = self.needed_images(manifest, services)
        if index is not None:
            names = [n for n in names if n in index.images]
        rows += [{"name": n, "status": "pending", "percent": 0} for n in [*names[1:], *third]]
        save()
        by_name = {r["name"]: r for r in rows}
        for name in names[1:]:
            ours(name, by_name[name])
        for name, ref in third.items():
            row = by_name[name]
            if index is not None:
                if not (self.docker.image_exists(ref) or self.docker.image_exists(self.third_party_tag(ref))):
                    row["status"] = "failed"
                    save()
                    raise fail("image_missing", image=name)
                row.update(status="done", percent=100)
                save()
            else:
                self._pull_one(row, ref, log, save)
        log(f"이미지 {len(rows)}개 준비 완료")

    def step_migrate(self, job: dict, step: dict, log) -> None:
        version = job["path"][job["version_index"]]
        job["ctx"]["migrate_started"] = True
        self._save(job)
        r = self._backend_run(["-m", "app.cli", "migrate"], version=version, timeout=3600, on_line=log)
        if not r.ok:
            raise fail("database_migrate_failed", r.err or r.out, exit_code=r.rc)
        log("데이터베이스 스키마를 새 버전에 맞췄습니다")

    def _backend_run(self, argv: list[str], *, version: str | None = None, user: str | None = None,
                     timeout: float = 600, on_line=None):
        """backend 이미지의 일회용 컨테이너(`compose run`)로 명령을 돌린다. version 을 주면 그 버전의 이미지로.

        compose 의 backend 서비스는 내부망의 고정 주소를 쓴다. 돌고 있는 backend 가 그 주소를 쥐고 있으므로
        일회용 컨테이너에서는 고정 주소를 뺀다(compose 조각을 하나 덧붙인다) — 아니면 "Address already in use" 다.
        """
        tmp = self.dir / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        network = tmp / "run-network.yml"
        network.write_text("services:\n  backend:\n    networks: !override\n      workspace: {}\n", encoding="utf-8")
        prefix = [*self.docker.compose_prefix(), "-f", network.as_posix()]
        override = tmp / "run-version.env"
        if version:
            write_private(override, f"JW_VERSION={version}\nJW_APP_VERSION={version}\n")
            prefix += ["--env-file", override.as_posix()]
        try:
            return self.docker.run([*prefix, "run", "--rm", "--no-deps", "-T", *(["--user", user] if user else []),
                                    "--entrypoint", "python", "backend", *argv], timeout=timeout, on_line=on_line)
        finally:
            override.unlink(missing_ok=True)

    def _write_pins(self, manifest: rel.Manifest | None, services: list[str]) -> None:
        """다이제스트로 찾을 수 없는(파일로 들여온) 남의 이미지를 들여온 이름으로 가리키는 compose 조각."""
        path = self.paths.stack / PINS_COMPOSE
        pins = {}
        for zone in (manifest.third_party if manifest else {}).values():
            for name, ref in zone.items():
                tag = self.third_party_tag(ref)
                if name in services and not self.docker.image_exists(ref) and self.docker.image_exists(tag):
                    pins[name] = tag
        if not pins:
            path.unlink(missing_ok=True)
            return
        lines = ["# 설치 관리자가 만든 파일입니다 — 파일로 들여온 이미지의 이름.", "services:"]
        for name, tag in sorted(pins.items()):
            lines += [f"  {name}:", f"    image: {tag}"]
        write_private(path, "\n".join(lines) + "\n", 0o644)

    def _up(self, services: list[str], log, *, recreate: bool = False) -> None:
        if not services:
            return
        args = ["up", "-d", "--no-build", "--no-deps"] + (["--force-recreate"] if recreate else []) + services
        r = self.docker.compose(*args, timeout=1800, on_line=log)
        if not r.ok:
            raise fail("service_start_failed", r.err, services=services)

    def _wait_ready(self, container: str, timeout: float = 600) -> None:
        waited = 0.0
        while True:
            st = self.docker.container_status(container)
            if st["running"] and st["health"] in ("", "healthy"):
                return
            if waited >= timeout:
                raise fail("service_not_ready", container=container, health=st["health"] or "stopped")
            self.sleep(3)
            waited += 3

    def _bring_up(self, log) -> None:
        """컨테이너를 지금의 스택 파일대로 맞춘다 — 구역, 프런트, nginx, 그리고 **backend 를 맨 마지막에**."""
        r = self.docker.compose("config", "-q", timeout=120)
        if not r.ok:
            raise fail("compose_invalid", r.err)
        services = self._services()
        others = [s for s in services if s not in LAST]
        self._up(others, log)
        for svc in others:
            if svc != "certbot":
                self._wait_ready(f"ws-{svc}")
        self._up(["frontend-react"], log)
        self._up(["nginx"], log, recreate=True)       # 설정 파일을 bind mount 하므로 다시 만들어야 새 파일을 읽는다
        self._wait_ready("ws-nginx", 180)
        log("backend 를 바꿉니다")
        self._up(["backend"], log)
        self._wait_ready("ws-backend", 600)
        self.docker.connect_self("jw-installer")

    def _handoff_done(self, job: dict, step: dict, version: str) -> bool:
        handoff = job["ctx"].get("handoff") or {}
        return handoff.get("step") == step["id"] and handoff.get("to") == version and handoff.get("state") == "done"

    def step_switch(self, job: dict, step: dict, log) -> None:
        version = job["path"][job["version_index"]]
        if self._handoff_done(job, step, version):
            log("새 설치 관리자가 이어받았습니다")
            return
        job["ctx"]["switch_started"] = True
        self._save(job)
        manifest = self.manifest(version)
        image = self.local_tag("installer", version)
        host = self.paths.host_dir
        r = self.docker.run(["run", "--rm", "--network", "none", "-v", f"{host}:/data", "-e", "JW_DATA_DIR=/data",
                             "-e", f"JW_HOST_DIR={host}", "-e", f"JW_REGISTRY={self.registry}",
                             "-e", f"JW_IMAGE_TAG={version}", "-e", f"JW_APP_VERSION={version}",
                             "--entrypoint", "python", image, "-m", "app.update_restack"],
                            timeout=300)
        if not r.ok:
            raise fail("stack_render_failed", r.err or r.out)
        log(f"스택 파일을 {version} 의 것으로 바꿨습니다")
        self._write_pins(manifest, self._services())
        self._bring_up(log)
        step["detail"]["disabled_plugins"] = []
        self._save(job)
        if self.own_version != version:
            self._handoff(job, step, image, version, log)

    def _handoff(self, job: dict, step: dict, image: str, version: str, log) -> None:
        """설치 관리자 자신을 `image` 로 바꾼다. 성공하면 이 프로세스는 여기서 끝난다(새 설치 관리자가 잇는다)."""
        result = self.dir / "swap-result.json"
        result.unlink(missing_ok=True)
        job["ctx"]["handoff"] = {"to": version, "image": image, "step": step["id"], "state": "pending",
                                 "started_at": self.iso()}
        self._save(job)
        me = self.docker.self_image()
        host = self.paths.host_dir
        r = self.docker.run(["run", "-d", "--rm", "--name", f"jw-installer-swap-{job['id'][:8]}",
                             "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", f"{host}:/data",
                             "--entrypoint", "python", me, "-m", "app.update_swap", "--container", self.docker.self_ref,
                             "--image", image, "--expect-version", version,
                             "--result", "/data/state/update/swap-result.json",
                             "--log", f"/data/state/update/jobs/{job['id']}.log"], timeout=120)
        if not r.ok:
            job["ctx"]["handoff"]["state"] = "failed"
            raise fail("installer_replace_failed", r.err)
        log(f"설치 관리자를 {version} 으로 바꿉니다 — 새 설치 관리자가 이어서 진행합니다")
        waited = 0
        while waited < HANDOFF_WAIT:
            self.sleep(2)
            waited += 2
            data = self._read("swap-result.json")
            if data is not None and not data.get("ok"):
                job["ctx"]["handoff"]["state"] = "failed"
                raise fail("installer_replace_failed", data.get("error") or "")
        job["ctx"]["handoff"]["state"] = "failed"
        raise fail("installer_replace_failed", "timeout")

    def _env_value(self, name: str) -> str:
        try:
            for line in self.paths.env_file.read_text(encoding="utf-8").splitlines():
                if line.startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip("'\"")
        except OSError:
            pass
        return ""

    def _verify(self, version: str, step: dict, log, manifest: rel.Manifest | None) -> None:
        if self.own_version != version:
            raise fail("installer_version_mismatch", installer=self.own_version, expected=version)
        for svc in self._services():
            if svc != "certbot":
                self._wait_ready(f"ws-{svc}", 300)
        # backend 컨테이너가 그 버전의 이미지로 떠 있는가 — 이미지 id 는 저장 방식에 따라 표기가 달라 이름으로 본다
        running = ((self.docker.inspect("container", "ws-backend") or {}).get("Config") or {}).get("Image") or ""
        if running and running.rsplit(":", 1)[-1] != version:
            raise fail("backend_image_mismatch", expected=version, actual=running)
        if self._env_value("JW_APP_VERSION") not in ("", version):
            raise fail("version_mismatch", expected=version, actual=self._env_value("JW_APP_VERSION"))
        code, _ = self.engine.http.get("http://backend:8000/api/health", timeout=10)
        if code != 200:
            raise fail("health_check_failed", status=code)
        schema = self.schema_status()
        if schema and schema.get("current") != schema.get("required"):
            raise fail("schema_mismatch", current=schema.get("current"), required=schema.get("required"))
        target = manifest.db_schema if manifest is not None and isinstance(manifest.db_schema, int) else None
        if target is not None and schema.get("current") not in (None, target):
            raise fail("schema_mismatch", current=schema.get("current"), required=target)
        step["detail"].update(version=version, schema_version=schema.get("current"))
        log(f"확인 완료: 버전 {version}, 스키마 {schema.get('current')}")

    def step_verify(self, job: dict, step: dict, log) -> None:
        version = job["path"][job["version_index"]]
        self._verify(version, step, log, self.manifest_or_none(version))

    # ─── 되돌림 · 복원 ───

    def _run_revert(self, job: dict) -> None:
        funcs = {"stop": self.revert_stop, "images": self.revert_images, "restore_db": self.revert_restore_db,
                 "start": self.revert_start, "verify": self.revert_verify}
        for step in job["steps"]:
            if step["status"] == "done":
                continue
            error = self._step(job, step, funcs)
            if error is not None:
                self._revert_failed(job, step, error)
                return
        self._finish_revert(job)

    def _parent(self, job: dict) -> dict | None:
        return self.job_raw(job["parent_job"]) if job.get("parent_job") else None

    def _revert_failed(self, job: dict, step: dict, error: eng.StepError) -> None:
        step.update(status="failed", finished_at=self.iso())
        point = self.point(job["ctx"].get("point") or "") or {}
        variables = {k: v for k, v in error.vars.items() if k != "detail"}
        variables.setdefault("backup_location", point.get("backup"))
        variables.setdefault("manual", "restore_manually")        # 손으로 해야 할 일의 문구 키(docs/data-safety.md 4절)
        job.update(status="failed", finished_at=self.iso(), choices=["retry"],
                   error={"step": step["id"], "cause": error.cause, "detail": error.vars.get("detail") or "",
                          "vars": variables})
        self._save(job)
        parent = self._parent(job)
        steps = self._snapshot_steps(job)
        if parent is not None:
            self._history_close(parent, "rollback_failed", version=job["from_version"],
                                rollback={"result": "failed", "steps": steps})
            self._mark_auto(parent, job, "rollback_failed")
        else:
            self._history_close(job, "restore_failed", version=job["from_version"],
                                versions=[{"version": job["target_version"], "steps": steps}])

    def _mark_auto(self, parent: dict, job: dict, result: str, downtime: int | None = None) -> None:
        if parent["trigger"] != "auto":
            return
        failed_step = (parent.get("error") or {}).get("step")
        self._save_settings(
            auto={"paused": True, "paused_at": self.iso(),
                  "reason": {"job": parent["id"], "step": failed_step, "version": parent["target_version"]}},
            last_auto={"job": parent["id"], "result": result, "version": parent["target_version"],
                       "from_version": parent["from_version"], "finished_at": job.get("finished_at"),
                       "downtime_seconds": downtime, "failed_step": failed_step})

    def _finish_revert(self, job: dict) -> None:
        job.update(status="done", finished_at=self.iso(), error=None, choices=[])
        self._save(job)
        self._set_active(None)
        target = job["target_version"]
        stored = self._read("current.json")
        if not stored or stored.get("version") != target:
            self._write("current.json", {"version": target, "applied_at": self.iso(), "previous_version": None})
        steps = self._snapshot_steps(job)
        parent = self._parent(job)
        if parent is not None:
            failed_step = (parent.get("error") or {}).get("step")
            downtime = self._end_maintenance(job, "rolled_back", version=target, from_version=parent["from_version"],
                                             failed_step=failed_step, trigger=parent["trigger"])
            self._history_close(parent, "rolled_back", version=target, downtime=downtime,
                                rollback={"result": "done", "steps": steps}, finished_at=job["finished_at"])
            self._mark_auto(parent, job, "rolled_back", downtime)
        else:
            downtime = self._end_maintenance(job, "restored", version=target, from_version=job["from_version"])
            self._history_close(job, "restored", version=target, downtime=downtime,
                                versions=[{"version": target, "steps": steps}])
            if (job.get("restore") or {}).get("reason") == "beta":
                self._drop_point(job["restore"]["point"])
                self._save_settings(channel="stable", beta={"since": None, "restore_point": None})
            chk = self.check_raw()
            chk["available"] = {"state": "none"}       # 버전이 바뀌었다 — 다음 확인이 다시 채운다
            self._write("check.json", chk)
            self._save_settings(next_check_at=None)

    def _skip(self, step: dict, log, why: str) -> None:
        step["detail"]["skipped"] = True
        log(f"건너뜁니다 — {why}")

    def revert_stop(self, job: dict, step: dict, log) -> None:
        if job["ctx"].get("light"):
            return self._skip(step, log, "바뀐 것이 없습니다")
        services = [s for s in self._services() if s not in KEEP_RUNNING]
        if services:
            r = self.docker.compose("stop", *services, timeout=600, on_line=log)
            if not r.ok:
                raise fail("service_stop_failed", r.err)

    def revert_images(self, job: dict, step: dict, log) -> None:
        if job["ctx"].get("light"):
            return self._skip(step, log, "바뀐 것이 없습니다")
        point = self.point(job["ctx"].get("point") or "")
        if point is None or not Path(point.get("snapshot") or "").is_dir():
            raise fail("restore_point_missing")
        snapshot = Path(point["snapshot"])
        if not (snapshot / PINS_COMPOSE).exists():
            (self.paths.stack / PINS_COMPOSE).unlink(missing_ok=True)
        shutil.copytree(snapshot, self.paths.stack, symlinks=True, dirs_exist_ok=True)
        r = self.docker.compose("config", "-q", timeout=120)
        if not r.ok:
            raise fail("compose_invalid", r.err)
        tag = f"{self._env_value('JW_REGISTRY') or self.registry}/{OUR_PREFIX}backend:{self._env_value('JW_VERSION')}"
        if not self.docker.image_exists(tag):
            raise fail("previous_image_missing", image=tag)
        log(f"스택 파일을 {point['version']} 의 것으로 되돌렸습니다")

    def revert_restore_db(self, job: dict, step: dict, log) -> None:
        if not job["ctx"].get("need_db"):
            return self._skip(step, log, "데이터베이스는 바뀌지 않았습니다")
        point = self.point(job["ctx"].get("point") or "")
        if point is None:
            raise fail("restore_point_missing")
        info = self._backup_schema(point)
        if info is not None and point.get("schema_version") is not None and info != point["schema_version"]:
            raise fail("restore_point_schema_mismatch", backup=info, expected=point["schema_version"])
        self._up(["postgres", "redis"], log)
        self._wait_ready("ws-postgres", 180)
        r = self._backend_run(["-m", "app.cli", "restore", point["backup"], "--items", "db", "--yes", "--json"],
                              user="0", timeout=7200, on_line=log)
        ok = False
        for line in reversed(r.out.splitlines()):
            try:
                ok = bool(json.loads(line).get("ok"))
                break
            except ValueError:
                continue
        if not r.ok or not ok:
            raise fail("db_restore_failed", r.err or r.out, exit_code=r.rc)
        log("데이터베이스를 백업 시점으로 되돌렸습니다")

    def _backup_schema(self, point: dict) -> int | None:
        r = self._backend_run(["-m", "app.cli", "backup", "inspect", point["backup"], "--json"], user="0", timeout=300)
        try:
            return json.loads(r.out).get("schema_version") if r.ok else None
        except ValueError:
            return None

    def revert_start(self, job: dict, step: dict, log) -> None:
        target = job["target_version"]
        if self._handoff_done(job, step, target):
            log("이전 설치 관리자가 이어받았습니다")
            return
        if job["ctx"].get("light"):
            self._up(["backend", "frontend-react", "nginx"], log)
            self._wait_ready("ws-backend", 600)
            return
        self._bring_up(log)
        if self.own_version != target:
            point = self.point(job["ctx"].get("point") or "") or {}
            image = point.get("installer_image") or self.local_tag("installer", target)
            if not self.docker.image_exists(image):
                raise fail("previous_image_missing", image=image)
            self._handoff(job, step, image, target, log)

    def revert_verify(self, job: dict, step: dict, log) -> None:
        self._verify(job["target_version"], step, log, None)

    # ─── 재시작 뒤 잇기 ───

    def resume(self) -> bool:
        """설치 관리자가 다시 떴을 때 — 돌던 작업이 있으면 잇는다. 자기 교체로 뜬 것이면 그 단계부터."""
        job = self.active()
        if job is None or job["status"] not in ("countdown", "running"):
            return False
        if job["status"] == "countdown":
            self._spawn(job["id"])
            return True
        step = next((s for s in job["steps"] if s["status"] == "running"), None)
        handoff = job["ctx"].get("handoff") or {}
        log = self._logger(job, step["id"] if step else "engine")
        if step is not None and handoff.get("state") == "pending" and handoff.get("step") == step["id"]:
            if handoff["to"] == self.own_version:
                handoff["state"] = "done"
                log(f"설치 관리자 {self.own_version} 이 작업을 이어받았습니다")
                step["status"] = "pending"
                self._save(job)
            else:
                handoff["state"] = "failed"
                result = self._read("swap-result.json") or {}
                log(f"설치 관리자를 바꾸지 못했습니다 — {self.own_version} 이 계속 돕니다")
                error = fail("installer_replace_failed", result.get("error") or "", expected=handoff["to"])
                self._save(job)
                target = self._update_failed if job["kind"] == "update" else self._revert_failed
                if self.background:
                    self._thread = threading.Thread(target=target, args=(job, step, error), name="jw-update", daemon=True)
                    self._thread.start()
                else:
                    target(job, step, error)
                return True
        elif step is not None:
            step["status"] = "pending"
            step["interrupted"] = True
            log("설치 관리자가 다시 시작해 이 단계를 다시 돕니다")
            self._save(job)
        self._spawn(job["id"])
        return True

    # ─── 복원 지점 ───

    def _drop_point(self, point_id: str) -> None:
        points = self.points()
        point = next((p for p in points if p["id"] == point_id), None)
        if point is None:
            return
        self._write("points.json", [p for p in points if p["id"] != point_id])
        backup = str(point.get("backup") or "")
        name = backup.rsplit("/", 1)[-1]
        if backup.startswith("/backups/") and SAFE_NAME.fullmatch(name):
            self.docker.exec("ws-backend", ["rm", "-rf", "--", f"/backups/{name}"], user="0", timeout=120)
        snapshot = self.dir / "snapshots" / point_id
        if SAFE_NAME.fullmatch(point_id) and snapshot.is_dir():
            shutil.rmtree(snapshot, ignore_errors=True)
        self._drop_images()

    def _drop_images(self) -> None:
        """복원 지점이 더는 가리키지 않는 옛 버전의 우리 이미지 태그를 지운다(실패해도 그만)."""
        keep = {self.current()["version"], self.own_version, *(p["version"] for p in self.points())}
        r = self.docker.run(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], timeout=60)
        prefix = f"{self.registry}/{OUR_PREFIX}"
        for ref in r.out.split() if r.ok else []:
            repo, _, tag = ref.rpartition(":")
            if repo.startswith(prefix) and rel.semver.is_product_version(tag) and tag not in keep:
                self.docker.run(["image", "rm", ref], timeout=120)

    def prune_points(self) -> list[str]:
        """보관 규칙: `pre-update` 는 최근 KEEP_POINTS 개, `pre-beta` 는 따로(Stable 로 돌아올 때까지)."""
        normal = [p for p in self.points() if p["kind"] == "pre-update"]
        dropped = [p["id"] for p in normal[KEEP_POINTS:]]
        for point_id in dropped:
            self._drop_point(point_id)
        return dropped

    def restore_points(self) -> dict:
        return {"points": [self.point_public(p) for p in self.points()]}

    # ─── 기록 ───

    def _history_open(self, job: dict) -> None:
        item = {"id": job["id"], "kind": job["kind"], "trigger": job["trigger"], "version": job["target_version"],
                "from_version": job["from_version"], "result": None, "started_at": job["started_at"],
                "finished_at": None, "duration_seconds": None, "downtime_seconds": None, "actor": job.get("actor"),
                "versions": [], "rollback": None}
        self._write("history.json", [item, *self.history_raw()])

    def _history_update(self, job_id: str, **changes) -> None:
        with self._lock:
            items = self.history_raw()
            for item in items:
                if item["id"] == job_id:
                    item.update({k: v for k, v in changes.items() if v is not None})
            self._write("history.json", items)

    def _history_close(self, job: dict, result: str, *, version, downtime: int | None = None, versions=None,
                       rollback=None, finished_at: str | None = None) -> None:
        finished = finished_at or job.get("finished_at") or self.iso()
        self._history_update(job["id"], result=result, version=version, finished_at=finished,
                             duration_seconds=seconds_between(job.get("started_at"), finished),
                             downtime_seconds=downtime, versions=versions, rollback=rollback)

    def prune_history(self) -> None:
        cutoff = self.now() - timedelta(days=RETENTION_DAYS)
        items = self.history_raw()
        keep = [i for i in items if not i.get("started_at") or parse_iso(i["started_at"]) >= cutoff]
        if len(keep) == len(items):
            return
        self._write("history.json", keep)
        alive = {i["id"] for i in keep} | {i.get("rollback_job") for i in keep} | {self.active_id()}
        for path in (self.dir / "jobs").glob("*.json"):
            job = self.job_raw(path.stem) or {}
            if path.stem in alive or (job.get("parent_job") and job["parent_job"] in alive):
                continue
            path.unlink(missing_ok=True)
            self.log_path(path.stem).unlink(missing_ok=True)

    @staticmethod
    def _history_row(item: dict) -> dict:
        return {k: item.get(k) for k in ("id", "kind", "trigger", "version", "from_version", "result", "started_at",
                                         "finished_at", "duration_seconds", "downtime_seconds", "actor")}

    def history(self, limit: int = 50, before: str | None = None) -> dict:
        items = [i for i in self.history_raw() if i.get("result")]
        if before:
            ids = [i["id"] for i in items]
            if before not in ids:
                raise UpdateError(404, "history_unknown")
            items = items[ids.index(before) + 1:]
        return {"items": [self._history_row(i) for i in items[:limit]], "retention_days": RETENTION_DAYS,
                "more": len(items) > limit}

    def history_entry(self, entry_id: str) -> dict:
        item = next((i for i in self.history_raw() if i["id"] == entry_id and i.get("result")), None)
        if item is None:
            raise UpdateError(404, "history_unknown")
        return {**self._history_row(item), "versions": item.get("versions") or [], "rollback": item.get("rollback")}

    def release_notes(self, version: str) -> dict:
        cur = self.current()
        applied = next((i for i in self.history_raw() if i["kind"] == "update" and i.get("result") == "success"
                        and version in [v["version"] for v in i.get("versions") or [{"version": i["version"]}]]), None)
        if version != cur["version"] and applied is None:
            raise UpdateError(404, "history_unknown")
        manifest = self.manifest_or_none(version)
        out = {"version": version, "channel": rel.version_channel(version),
               "published": manifest.published if manifest else None,
               "changelog": manifest.changelog if manifest else None}
        if applied is not None:
            job = self.job_raw(applied["id"]) or {}
            switch = next((s for s in job.get("steps", []) if s["id"] == "switch"), {})
            out.update(applied_at=applied["finished_at"], trigger=applied["trigger"],
                       downtime_seconds=applied.get("downtime_seconds"), previous_version=applied.get("from_version"),
                       disabled_plugins=(switch.get("detail") or {}).get("disabled_plugins") or [])
        return out

    def apps(self) -> dict:
        version = self.current()["version"]
        manifest = self.manifest_or_none(version)
        apps = [{"kind": a.kind, "version": version, "filename": a.filename, "size_bytes": a.size, "url": a.url}
                for a in (manifest.apps if manifest else ())]
        return {"version": version, "download_page": "/settings/apps" if apps else None, "apps": apps}
