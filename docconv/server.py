#!/usr/bin/env python3
"""ws-docconv — LibreOffice headless 문서 변환 서버(표준 라이브러리만).

  POST /convert?from=<확장자>&to=<pdf|docx|odt|xlsx|ods|pptx|odp>   본문 = 원본 바이트 → 변환 결과 바이트
  GET  /health

* 네트워크 없음(compose network_mode: none). 공유 볼륨의 유닉스 소켓(DOCCONV_LISTEN)으로만 받는다.
* DOCCONV_TOKEN 이 있으면 X-Docconv-Token 헤더가 같아야 한다.
* 동시 변환 DOCCONV_CONCURRENCY(기본 2) — 넘치면 DOCCONV_QUEUE_WAIT 초 기다리다 429.
* 작업마다 새 임시 디렉터리 + 새 LibreOffice 사용자 프로필(템플릿 복사) → 끝나면 통째로 지운다.
* 시간 DOCCONV_TIMEOUT(기본 120초) 넘으면 프로세스 그룹째 죽이고 504. 크기 DOCCONV_MAX_MB(기본 100).
* HWP/HWPX 는 H2Orestart 확장(이미지에 --shared 설치)이 읽는다.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

LISTEN = os.environ.get("DOCCONV_LISTEN", "unix:/run/docconv/docconv.sock")
TOKEN = os.environ.get("DOCCONV_TOKEN", "").strip()
CONCURRENCY = max(1, int(os.environ.get("DOCCONV_CONCURRENCY", "2")))
QUEUE_WAIT = float(os.environ.get("DOCCONV_QUEUE_WAIT", "60"))
TIMEOUT = float(os.environ.get("DOCCONV_TIMEOUT", "120"))
MAX_BYTES = int(float(os.environ.get("DOCCONV_MAX_MB", "100")) * 1024 * 1024)
PROFILE_TEMPLATE = os.environ.get("DOCCONV_PROFILE_TEMPLATE", "/opt/lo-profile")
WORK_ROOT = os.environ.get("DOCCONV_WORK", "/tmp/docconv")
SOFFICE = os.environ.get("DOCCONV_SOFFICE", "soffice")

FAMILY = {
    "writer": {"doc", "docx", "docm", "dotx", "odt", "rtf", "hwp", "hwpx", "wpd"},
    "calc": {"xls", "xlsx", "xlsm", "ods", "csv"},
    "impress": {"ppt", "pptx", "ppsx", "pps", "odp"},
}
TARGETS = {
    "writer": {"pdf": "pdf:writer_pdf_Export", "docx": "docx:MS Word 2007 XML", "odt": "odt"},
    "calc": {"pdf": "pdf:calc_pdf_Export", "xlsx": "xlsx:Calc MS Excel 2007 XML", "ods": "ods"},
    "impress": {"pdf": "pdf:impress_pdf_Export", "pptx": "pptx:Impress MS PowerPoint 2007 XML", "odp": "odp"},
}
MIME = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "odt": "application/vnd.oasis.opendocument.text",
    "ods": "application/vnd.oasis.opendocument.spreadsheet",
    "odp": "application/vnd.oasis.opendocument.presentation",
}

_slots = threading.BoundedSemaphore(CONCURRENCY)
_busy = 0
_busy_lock = threading.Lock()


def family_of(ext: str) -> str | None:
    for fam, exts in FAMILY.items():
        if ext in exts:
            return fam
    return None


class ConvertFailed(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def convert(data: bytes, src: str, to: str) -> bytes:
    fam = family_of(src)
    if fam is None:
        raise ConvertFailed(415, "unsupported", f"지원하지 않는 원본 형식: {src}")
    filt = TARGETS[fam].get(to)
    if filt is None:
        raise ConvertFailed(415, "unsupported", f"{src} → {to} 변환은 지원하지 않습니다")
    os.makedirs(WORK_ROOT, exist_ok=True)
    job = tempfile.mkdtemp(prefix="job-", dir=WORK_ROOT)
    try:
        indir, outdir, prof = (os.path.join(job, d) for d in ("in", "out", "profile"))
        os.mkdir(indir)
        os.mkdir(outdir)
        if os.path.isdir(PROFILE_TEMPLATE):
            shutil.copytree(PROFILE_TEMPLATE, prof, symlinks=True)
        src_path = os.path.join(indir, f"input.{src}")
        with open(src_path, "wb") as f:
            f.write(data)
        cmd = [SOFFICE, "--headless", "--invisible", "--nologo", "--nodefault", "--nolockcheck", "--norestore",
               "--nofirststartwizard", f"-env:UserInstallation=file://{prof}",
               "--convert-to", filt, "--outdir", outdir, src_path]
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": job, "TMPDIR": job,
               "LANG": "ko_KR.UTF-8", "LC_ALL": "C.UTF-8", "SAL_USE_VCLPLUGIN": "svp"}
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=job,
                             start_new_session=True)
        try:
            out, err = p.communicate(timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            _kill_group(p)
            raise ConvertFailed(504, "timeout", f"변환 시간이 지났습니다({int(TIMEOUT)}초)")
        finally:
            _kill_group(p)       # 남은 자식(oosplash·java) 정리
        produced = [n for n in os.listdir(outdir) if not n.startswith(".")]
        if not produced:
            tail = (err or b"").decode("utf-8", "replace")[-400:] or (out or b"").decode("utf-8", "replace")[-400:]
            raise ConvertFailed(422, "convert_failed",
                                "변환하지 못했습니다(손상·암호·지원 안 하는 문서일 수 있음)" + (f": {tail.strip()}" if tail.strip() else ""))
        with open(os.path.join(outdir, produced[0]), "rb") as f:
            return f.read()
    finally:
        shutil.rmtree(job, ignore_errors=True)


def _kill_group(p: subprocess.Popen) -> None:
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        p.wait(timeout=5)
    except Exception:  # noqa: BLE001
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "ws-docconv/1"
    protocol_version = "HTTP/1.1"

    def address_string(self):        # 유닉스 소켓엔 클라이언트 주소가 없다
        return "local"

    def log_message(self, fmt, *args):
        sys.stderr.write("[docconv] " + (fmt % args) + "\n")

    def _json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlsplit(self.path).path == "/health":
            self._json(200, {"ok": True, "busy": _busy, "slots": CONCURRENCY})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self):
        global _busy
        u = urlsplit(self.path)
        if u.path != "/convert":
            return self._json(404, {"error": "not_found"})
        if TOKEN and self.headers.get("X-Docconv-Token", "") != TOKEN:
            return self._json(401, {"error": "unauthorized"})
        q = parse_qs(u.query)
        src = (q.get("from", [""])[0] or "").lower().lstrip(".")
        to = (q.get("to", [""])[0] or "").lower().lstrip(".")
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if n <= 0:
            return self._json(400, {"error": "empty", "message": "본문이 비었습니다"})
        if n > MAX_BYTES:
            return self._json(413, {"error": "too_large", "message": f"파일이 너무 큽니다(상한 {MAX_BYTES // 1024 // 1024}MB)"})
        data = self.rfile.read(n)
        if not _slots.acquire(timeout=QUEUE_WAIT):
            return self._json(429, {"error": "busy", "message": "변환 서버가 바쁩니다. 잠시 뒤 다시 시도하세요"})
        with _busy_lock:
            _busy += 1
        t0 = time.monotonic()
        try:
            out = convert(data, src, to)
        except ConvertFailed as e:
            return self._json(e.status, {"error": e.code, "message": e.message})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[docconv] internal error: {e!r}\n")
            return self._json(500, {"error": "internal", "message": "변환 서버 내부 오류"})
        finally:
            with _busy_lock:
                _busy -= 1
            _slots.release()
        self.log_message("convert %s->%s %dB -> %dB %.1fs", src, to, len(data), len(out), time.monotonic() - t0)
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(to, "application/octet-stream"))
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class UnixHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True

    def server_bind(self):
        try:
            os.unlink(self.server_address)
        except FileNotFoundError:
            pass
        self.socket.bind(self.server_address)
        os.chmod(self.server_address, 0o666)      # 볼륨을 함께 쓰는 백엔드(다른 uid)가 접속
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
    """compose healthcheck — 소켓으로 /health."""
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
    srv = make_server()
    sys.stderr.write(f"[docconv] listening on {LISTEN} (slots={CONCURRENCY}, timeout={TIMEOUT}s, "
                     f"max={MAX_BYTES // 1024 // 1024}MB, token={'set' if TOKEN else 'none'})\n")
    def _term(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _term)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
