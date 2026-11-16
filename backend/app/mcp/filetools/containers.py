"""변환(ws-docconv)·분석 샌드박스(ws-sandbox) 컨테이너 클라이언트.

두 컨테이너 모두 **네트워크가 없다**(network_mode: none). 백엔드와는 공유 볼륨의 유닉스 소켓으로만 통신한다
(docker-compose.yml: docconv-sock → /run/docconv, sandbox-sock → /run/sandbox). 따라서 포트 공개도,
샌드박스 내부 코드의 외부 통신도 원천적으로 불가하다. 요청은 공유 비밀(헤더)로 인증한다.

주소는 환경변수로 변경할 수 있다: ``unix:///경로`` 또는 ``http://호스트:포트``(개발용).
"""

from __future__ import annotations

import base64
import os

import httpx

DOCCONV_URL = os.getenv("DOCCONV_URL", "unix:///run/docconv/docconv.sock")
SANDBOX_URL = os.getenv("SANDBOX_URL", "unix:///run/sandbox/sandbox.sock")

# docconv 가 지원하는 변환 — (원본 확장자 집합, 대상)
_WRITER = {".doc", ".docx", ".odt", ".rtf", ".hwp", ".hwpx", ".wpd", ".dotx", ".docm"}
_CALC = {".xls", ".xlsx", ".xlsm", ".ods", ".csv"}
_IMPRESS = {".ppt", ".pptx", ".odp", ".ppsx", ".pps"}
DOCCONV_TARGETS = {
    "writer": ("pdf", "docx", "odt"),
    "calc": ("pdf", "xlsx", "ods"),
    "impress": ("pdf", "pptx", "odp"),
}


def docconv_family(ext: str) -> str | None:
    ext = ext.lower()
    if ext in _WRITER:
        return "writer"
    if ext in _CALC:
        return "calc"
    if ext in _IMPRESS:
        return "impress"
    return None


class ContainerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _client(url: str, timeout: float) -> tuple[httpx.AsyncClient, str]:
    """(클라이언트, 기준 URL). 테스트에서 이 함수를 대체한다."""
    if url.startswith("unix://"):
        path = url[len("unix://"):]
        return httpx.AsyncClient(transport=httpx.AsyncHTTPTransport(uds=path), timeout=timeout,
                                 trust_env=False), "http://local"
    return httpx.AsyncClient(timeout=timeout, trust_env=False), url.rstrip("/")


def _token(name: str) -> str:
    return os.getenv(name, "").strip()


def _map_status(status: int, name: str, detail: str) -> ContainerError:
    code = {400: "invalid_argument", 401: "internal", 403: "internal", 413: "too_large", 415: "unsupported",
            422: "unsupported", 429: "rate_limited", 503: "unavailable", 504: "timeout"}.get(status, "internal")
    if status in (401, 403):
        detail = f"{name} 인증 실패 — 백엔드와 컨테이너의 공유 비밀 설정을 확인하세요"
    return ContainerError(code, detail or f"{name} 오류(HTTP {status})")


def _detail(r: httpx.Response) -> str:
    try:
        d = r.json()
        return str(d.get("message") or d.get("error") or "")[:500]
    except Exception:  # noqa: BLE001
        return r.text[:300]


# ── ws-docconv ────────────────────────────────────────────────
async def docconv_convert(data: bytes, src_ext: str, target: str, timeout: float = 200.0) -> bytes:
    fam = docconv_family(src_ext)
    if fam is None or target not in DOCCONV_TARGETS[fam]:
        raise ContainerError("unsupported", f"{src_ext} → {target} 변환은 지원하지 않습니다")
    client, base = _client(DOCCONV_URL, timeout)
    headers = {"Content-Type": "application/octet-stream"}
    tok = _token("DOCCONV_TOKEN")
    if tok:
        headers["X-Docconv-Token"] = tok
    try:
        async with client:
            r = await client.post(f"{base}/convert", params={"from": src_ext.lstrip(".").lower(), "to": target},
                                  content=data, headers=headers)
    except (httpx.ConnectError, FileNotFoundError, ConnectionError, httpx.RemoteProtocolError) as e:
        raise ContainerError("unavailable", f"변환 서버(ws-docconv)에 연결할 수 없습니다 — 관리자에게 문의하세요 ({e.__class__.__name__})")
    except httpx.TimeoutException:
        raise ContainerError("timeout", "변환 시간이 지났습니다")
    if r.status_code != 200:
        raise _map_status(r.status_code, "변환 서버", _detail(r))
    if not r.content:
        raise ContainerError("internal", "변환 결과가 비었습니다")
    return r.content


# ── ws-sandbox ────────────────────────────────────────────────
async def sandbox_run(code: str, files: list[tuple[str, bytes]], timeout_sec: int) -> dict:
    """{exit_code, timed_out, stdout, stderr, stdout_truncated, stderr_truncated, files:[{name,data,size}],
    files_skipped, duration_ms}."""
    tok = _token("SANDBOX_TOKEN")
    if not tok:
        raise ContainerError("unavailable", "분석 샌드박스가 설정되지 않았습니다(SANDBOX_TOKEN) — 관리자에게 문의하세요")
    client, base = _client(SANDBOX_URL, timeout_sec + 30.0)
    body = {"code": code, "timeout": int(timeout_sec),
            "files": [{"name": n, "data": base64.b64encode(b).decode("ascii")} for n, b in files]}
    try:
        async with client:
            r = await client.post(f"{base}/run", json=body, headers={"Authorization": f"Bearer {tok}"})
    except (httpx.ConnectError, FileNotFoundError, ConnectionError, httpx.RemoteProtocolError) as e:
        raise ContainerError("unavailable", f"분석 샌드박스(ws-sandbox)에 연결할 수 없습니다 — 관리자에게 문의하세요 ({e.__class__.__name__})")
    except httpx.TimeoutException:
        raise ContainerError("timeout", "실행 시간이 지났습니다")
    if r.status_code != 200:
        raise _map_status(r.status_code, "분석 샌드박스", _detail(r))
    try:
        d = r.json()
    except ValueError:
        raise ContainerError("internal", "샌드박스 응답을 읽지 못했습니다")
    out_files = []
    for f in d.get("files") or []:
        try:
            raw = base64.b64decode(f.get("data") or "", validate=True)
        except Exception:  # noqa: BLE001
            continue
        out_files.append({"name": str(f.get("name") or "output"), "data": raw, "size": len(raw)})
    d["files"] = out_files
    return d
