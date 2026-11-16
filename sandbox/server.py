#!/usr/bin/env python3
"""ws-sandbox — 격리 Python 실행 서버(표준 라이브러리만 사용).

  POST /run   {"code": str, "timeout": int, "files": [{"name": str, "data": base64}]}   Authorization: Bearer <SANDBOX_TOKEN>
  → {"exit_code", "timed_out", "killed_reason", "stdout", "stderr", "stdout_truncated", "stderr_truncated",
     "files": [{"name", "data"(base64), "size"}], "files_skipped", "duration_ms"}
  GET  /health

격리(다중 계층):
  * 컨테이너: 네트워크 없음(network_mode: none), 읽기 전용 루트, /tmp 만 tmpfs, cap 최소(SETUID·SETGID·CHOWN·KILL),
    no-new-privileges, 메모리·CPU·pids 상한(compose).
  * 실행: 요청마다 새 작업 디렉터리, **슬롯마다 상이한 비루트 uid**(동시 실행 간 상호 파일 접근 불가),
    setsid + rlimit(주소공간·CPU·파일 크기·열린 파일·프로세스 수·코어 0), 벽시계 시간 초과 시 프로세스 그룹 및 해당 uid 의
    잔여 프로세스를 모두 종료한다. 환경변수는 최소(토큰 없음).
  * 결과 수집·정리도 해당 uid 로 실행된다(서버가 사용자 코드가 생성한 파일을 직접 추적하지 않는다 — 심볼릭 링크 함정 차단).
  * 서버 비밀(SANDBOX_TOKEN)이 없으면 모든 실행을 거부한다.
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import queue
import resource
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

LISTEN = os.environ.get("SANDBOX_LISTEN", "unix:/run/sandbox/sandbox.sock")
TOKEN = os.environ.get("SANDBOX_TOKEN", "").strip()
SLOTS = max(1, int(os.environ.get("SANDBOX_CONCURRENCY", "2")))
BASE_UID = int(os.environ.get("SANDBOX_BASE_UID", "20001"))
QUEUE_WAIT = float(os.environ.get("SANDBOX_QUEUE_WAIT", "30"))
MAX_TIMEOUT = int(os.environ.get("SANDBOX_MAX_TIMEOUT", "120"))
MEM_MB = int(os.environ.get("SANDBOX_MEM_MB", "1536"))
MAX_REQUEST = int(float(os.environ.get("SANDBOX_MAX_REQUEST_MB", "48")) * 1024 * 1024)
MAX_CODE = 100_000
MAX_INPUTS = 20
OUT_TEXT = int(os.environ.get("SANDBOX_MAX_OUTPUT_KB", "256")) * 1024
MAX_OUT_FILES = int(os.environ.get("SANDBOX_MAX_FILES", "20"))
MAX_OUT_BYTES = int(float(os.environ.get("SANDBOX_MAX_FILES_MB", "25")) * 1024 * 1024)
FILE_LIMIT = 64 * 1024 * 1024                 # 파일 하나(출력 포함) 크기 rlimit
WORK_ROOT = os.environ.get("SANDBOX_WORK", "/tmp/jobs")
PYTHON = os.environ.get("SANDBOX_PYTHON", sys.executable)
MPL_CACHE = os.environ.get("SANDBOX_MPL_CACHE", "/opt/sandbox/mplcache")
HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "helpers.py")

_slots: "queue.Queue[int]" = queue.Queue()
for _i in range(SLOTS):
    _slots.put(_i)
_busy = 0
_busy_lock = threading.Lock()


class RunError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _safe_name(n: str) -> str:
    n = os.path.basename(str(n or "")).replace("\x00", "")
    if not n or n in (".", "..") or n.startswith("."):
        raise RunError(400, "invalid_argument", f"입력 파일 이름이 잘못됐습니다: {n!r}")
    return n[:200]


def _limits(mem_mb: int, cpu_sec: int):
    def apply():
        mem = mem_mb * 1024 * 1024
        for res, val in ((resource.RLIMIT_AS, mem), (resource.RLIMIT_CPU, cpu_sec),
                         (resource.RLIMIT_FSIZE, FILE_LIMIT), (resource.RLIMIT_NOFILE, 256),
                         (resource.RLIMIT_NPROC, 64), (resource.RLIMIT_CORE, 0)):
            try:
                resource.setrlimit(res, (val, val))
            except (ValueError, OSError):
                pass
    return apply


def _env(work: str) -> dict:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": work, "TMPDIR": os.path.join(work, ".tmp"),
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1",
        "MPLBACKEND": "Agg", "MPLCONFIGDIR": os.path.join(work, ".mpl"),
        "MATPLOTLIBRC": "/opt/sandbox/matplotlibrc",
        "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "NUMEXPR_MAX_THREADS": "1",
        "ARROW_DEFAULT_MEMORY_POOL": "system",
    }


def _as_slot(slot: int, args: list[str], *, cwd: str, timeout: float, mem_mb: int = 512, cpu: int = 30,
             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env: dict | None = None) -> subprocess.CompletedProcess:
    uid = BASE_UID + slot
    return subprocess.run(args, cwd=cwd, user=uid, group=uid, extra_groups=[], umask=0o077,
                          env=env or {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                          preexec_fn=_limits(mem_mb, cpu), stdout=stdout, stderr=stderr, timeout=timeout,
                          stdin=subprocess.DEVNULL, check=False)


def _kill_uid(slot: int) -> None:
    """해당 슬롯 uid 의 잔여 프로세스를 전부 종료한다(데몬화·이중 fork 대비). kill(-1) 은 동일 uid 에만 도달한다."""
    try:
        _as_slot(slot, [PYTHON, "-I", "-S", "-c", "import os,signal\ntry: os.kill(-1, signal.SIGKILL)\nexcept Exception: pass"],
                 cwd="/", timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:  # noqa: BLE001
        pass


def _read_capped(path: str, cap: int) -> tuple[str, bool]:
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size <= cap:
                raw = f.read()
                cut = False
            else:
                head = f.read(cap * 3 // 4)
                f.seek(size - cap // 4)
                raw = head + b"\n... (output truncated) ...\n" + f.read()
                cut = True
        return raw.decode("utf-8", "replace"), cut
    except OSError:
        return "", False


def run_job(code: str, files: list[dict], timeout: int) -> dict:
    slot = _slots.get(timeout=QUEUE_WAIT)
    uid = BASE_UID + slot
    os.makedirs(WORK_ROOT, mode=0o711, exist_ok=True)
    root = tempfile.mkdtemp(prefix="job-", dir=WORK_ROOT)     # 서버(root) 소유 0700 — 로그만 저장
    work = os.path.join(root, "w")
    t0 = time.monotonic()
    try:
        os.chmod(root, 0o711)
        os.mkdir(work, 0o700)
        for d in ("input", "output", ".tmp", ".mpl"):
            os.mkdir(os.path.join(work, d), 0o700)
        if os.path.isdir(MPL_CACHE):                           # 글꼴 캐시(매번 재생성하면 수 초 소요)
            for n in os.listdir(MPL_CACHE):
                src = os.path.join(MPL_CACHE, n)
                if os.path.isfile(src):
                    shutil.copy2(src, os.path.join(work, ".mpl", n))
        for f in files:
            with open(os.path.join(work, "input", _safe_name(f["name"])), "wb") as fh:
                fh.write(f["bytes"])
        with open(os.path.join(work, "main.py"), "w", encoding="utf-8") as fh:
            fh.write(code)
        # 소유자 = 슬롯 uid, 그룹 = 0(서버). 서버는 DAC_OVERRIDE 없이도 그룹 권한으로 진입하여 chdir·정리가 가능하고,
        # 다른 슬롯 uid 는 그룹 0 이 아니므로 진입할 수 없다. 사용자 코드가 새로 생성하는 파일은 umask 077(해당 uid 전용).
        for dirpath, dirnames, filenames in os.walk(work, topdown=False):
            for n in filenames:
                fp = os.path.join(dirpath, n)
                os.chmod(fp, 0o660)  # 소유자 이전 전에 수행(이전 후에는 FOWNER 없이 변경 불가)
                os.chown(fp, uid, 0)
            os.chmod(dirpath, 0o770)
            os.chown(dirpath, uid, 0)
        out_path, err_path = os.path.join(root, "stdout"), os.path.join(root, "stderr")
        timed_out = False
        killed_reason = None
        with open(out_path, "wb") as so, open(err_path, "wb") as se:
            p = subprocess.Popen([PYTHON, "-I", "-B", "-X", "utf8", "main.py"], cwd=work, user=uid, group=uid,
                                 extra_groups=[], umask=0o077, env=_env(work), start_new_session=True,
                                 preexec_fn=_limits(MEM_MB, timeout + 5), stdin=subprocess.DEVNULL,
                                 stdout=so, stderr=se)
            try:
                rc = p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                killed_reason = "timeout"
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                rc = p.wait()
        _kill_uid(slot)
        if rc in (-signal.SIGKILL, -signal.SIGXCPU) and not timed_out:
            killed_reason = "cpu_or_memory_limit"
        stdout, so_cut = _read_capped(out_path, OUT_TEXT)
        stderr, se_cut = _read_capped(err_path, OUT_TEXT // 2)
        if rc != 0 and "MemoryError" in stderr:
            killed_reason = killed_reason or "memory_limit"
        # 결과 파일 — 해당 uid 로 수집하여 JSON 으로 수신(링크·특수 파일은 건너뜀)
        collected = {"files": [], "skipped": []}
        try:
            cp = _as_slot(slot, [PYTHON, "-I", "-S", HELPERS, "collect", os.path.join(work, "output"),
                                 str(MAX_OUT_FILES), str(MAX_OUT_BYTES)], cwd=work, timeout=60, mem_mb=1024)
            if cp.returncode == 0 and cp.stdout:
                collected = json.loads(cp.stdout.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            collected["skipped"].append(f"결과 파일 수집 실패: {e.__class__.__name__}")
        return {
            "exit_code": rc, "timed_out": timed_out, "killed_reason": killed_reason,
            "stdout": stdout, "stderr": stderr, "stdout_truncated": so_cut, "stderr_truncated": se_cut,
            "files": collected.get("files") or [], "files_skipped": collected.get("skipped") or [],
            "duration_ms": int((time.monotonic() - t0) * 1000),
        }
    finally:
        try:
            _kill_uid(slot)
            if os.path.isdir(work):
                _as_slot(slot, [PYTHON, "-I", "-S", HELPERS, "clean", work], cwd="/", timeout=60,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(root, ignore_errors=True)
        if os.path.exists(root):
            sys.stderr.write(f"[sandbox] warning: could not fully remove {root}\n")
        _slots.put(slot)


class Handler(BaseHTTPRequestHandler):
    server_version = "ws-sandbox/1"
    protocol_version = "HTTP/1.1"

    def address_string(self):
        return "local"

    def log_message(self, fmt, *args):
        sys.stderr.write("[sandbox] " + (fmt % args) + "\n")

    def _json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlsplit(self.path).path == "/health":
            self._json(200, {"ok": True, "busy": _busy, "slots": SLOTS, "configured": bool(TOKEN)})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self):
        global _busy
        if urlsplit(self.path).path != "/run":
            return self._json(404, {"error": "not_found"})
        if not TOKEN:
            return self._json(503, {"error": "not_configured", "message": "샌드박스 공유 비밀(SANDBOX_TOKEN)이 설정되지 않았습니다"})
        auth = self.headers.get("Authorization", "")
        if not hmac.compare_digest(auth.encode(), f"Bearer {TOKEN}".encode()):
            return self._json(401, {"error": "unauthorized"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if n <= 0:
            return self._json(400, {"error": "empty"})
        if n > MAX_REQUEST:
            return self._json(413, {"error": "too_large", "message": f"요청이 너무 큽니다(상한 {MAX_REQUEST // 1024 // 1024}MB)"})
        try:
            body = json.loads(self.rfile.read(n))
            code = body["code"]
            if not isinstance(code, str) or not code.strip():
                raise ValueError("code")
            if len(code) > MAX_CODE:
                return self._json(413, {"error": "too_large", "message": "코드가 너무 깁니다"})
            timeout = max(1, min(MAX_TIMEOUT, int(body.get("timeout") or 60)))
            raw_files = body.get("files") or []
            if not isinstance(raw_files, list) or len(raw_files) > MAX_INPUTS:
                raise ValueError("files")
            files, seen = [], set()
            for f in raw_files:
                name = _safe_name(f.get("name"))
                if name.lower() in seen:
                    raise RunError(400, "invalid_argument", f"입력 파일 이름이 겹칩니다: {name}")
                seen.add(name.lower())
                files.append({"name": name, "bytes": base64.b64decode(f.get("data") or "", validate=True)})
        except RunError as e:
            return self._json(e.status, {"error": e.code, "message": e.message})
        except (ValueError, KeyError, TypeError) as e:
            return self._json(400, {"error": "invalid_argument", "message": f"요청 형식이 잘못됐습니다: {e}"})
        with _busy_lock:
            _busy += 1
        try:
            result = run_job(code, files, timeout)
        except queue.Empty:
            return self._json(429, {"error": "busy", "message": "샌드박스가 바쁩니다. 잠시 뒤 다시 시도하세요"})
        except RunError as e:
            return self._json(e.status, {"error": e.code, "message": e.message})
        except Exception as e:  # noqa: BLE001
            import traceback

            sys.stderr.write(f"[sandbox] internal error: {e!r}\n{traceback.format_exc(limit=8)}")
            return self._json(500, {"error": "internal", "message": "샌드박스 내부 오류"})
        finally:
            with _busy_lock:
                _busy -= 1
        self.log_message("run rc=%s timeout=%s files=%d %dms", result["exit_code"], result["timed_out"],
                         len(result["files"]), result["duration_ms"])
        self._json(200, result)


class UnixHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True

    def server_bind(self):
        try:
            os.unlink(self.server_address)
        except FileNotFoundError:
            pass
        self.socket.bind(self.server_address)
        os.chmod(self.server_address, 0o666)       # 볼륨을 공유하는 백엔드(다른 uid)가 접속
        self.server_name, self.server_port = "local", 0

    def get_request(self):
        req, _ = self.socket.accept()
        return req, ("local", 0)


def make_server():
    if LISTEN.startswith("unix:"):
        path = LISTEN[len("unix:"):]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return UnixHTTPServer(path, Handler)
    host, _, port = LISTEN.removeprefix("tcp:").rpartition(":")
    return ThreadingHTTPServer((host or "127.0.0.1", int(port)), Handler)


def health_check() -> int:
    try:
        if LISTEN.startswith("unix:"):
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(5)
            s.connect(LISTEN[len("unix:"):])
        else:
            host, _, port = LISTEN.removeprefix("tcp:").rpartition(":")
            s = socket.create_connection((host or "127.0.0.1", int(port)), timeout=5)
        s.sendall(b"GET /health HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n")
        ok = s.recv(64).startswith(b"HTTP/1.1 200")
        s.close()
        return 0 if ok else 1
    except OSError:
        return 1


if __name__ == "__main__":
    if "--health" in sys.argv:
        sys.exit(health_check())
    if os.geteuid() != 0:
        sys.stderr.write("[sandbox] warning: not root — per-slot uid isolation unavailable, runs will fail\n")
    srv = make_server()
    sys.stderr.write(f"[sandbox] listening on {LISTEN} (slots={SLOTS}, max_timeout={MAX_TIMEOUT}s, mem={MEM_MB}MB, "
                     f"token={'set' if TOKEN else 'MISSING — all runs refused'})\n")

    def _term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _term)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
