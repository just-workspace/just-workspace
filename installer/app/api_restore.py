"""복원의 마법사 API — `/api/restore/*` (8443, 세션 필요). 동작은 app/restore.py 가 한다.

| 메서드·경로 | 하는 일 |
|---|---|
| `POST /api/restore/upload` | 백업 파일 올리기(multipart `file` 또는 본문 그대로) — 디스크에 바로 흘려 쓴다. 끝나면 확인까지 하고 답한다 |
| `POST /api/restore/path` `{"path"}` | 서버(호스트)에 이미 있는 백업 파일·폴더 |
| `POST /api/restore/password` `{"password"}` | 설정이 암호로 보호된 백업 — 암호를 넣고 다시 확인 |
| `GET` · `DELETE /api/restore/file` | 받아 둔 백업의 상태 · 버리기 |
| `GET /api/restore/review` | 백업의 내용과 버전 판정 |
| `POST /api/restore/apply` | 새 서버에서 정한 값으로 복원 시작(202) |
| `GET /api/restore/apply` · `/apply/stream` · `POST /api/restore/apply/retry` | 진행 — 설치 적용과 같은 형태 |
"""

from __future__ import annotations

from pathlib import Path

from fastapi import Body, Depends, FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect

from app import answers as ans
from app.restore import ARCHIVE_SUFFIX, RestoreError, RestoreManager

CHUNK_LIMIT = 8 * 1024 * 1024


class UploadInvalid(Exception):
    pass


def manager(svc) -> RestoreManager:
    """서비스 묶음마다 하나 — 접속 주소 확인(DNS)은 마법사의 확인과 같은 길을 쓴다."""
    if "restore" not in svc.cache:
        def dns_status(domain: str) -> str:
            from app import api, probes

            ip = api.public_ip(svc).get("ip")
            return probes.probe_dns(domain, ip, svc.resolver)["status"]

        svc.cache["restore"] = RestoreManager.for_engine(svc.engine, dns_status=dns_status)
    return svc.cache["restore"]


def nfs_probe(svc, result: dict, server: str, export: str) -> dict:
    """복원 중의 NFS 확인 — 다섯 항목이 통과하면 표식 파일의 설치 id 가 백업의 것과 같은지도 본다.

    백업이 NFS 였는데 표식이 없으면 다른 공유(또는 빈 공유)다 → `marker_missing`.
    다른 설치의 표식이 있으면 → `other_install`. 새 설치(복원이 아님)에서는 아무것도 더하지 않는다.
    """
    mgr = manager(svc)
    if not result.get("ok") or svc.store.answers_public().get("mode") != "restore" or not mgr.ready:
        return result
    try:
        answers = ans.load({"storage": {"kind": "nfs", "server": server, "export": export}})
        verdict = mgr.marker_verdict(answers)
    except Exception:  # noqa: BLE001 — 표식을 읽지 못하면 판정 없이 둔다(적용 단계가 다시 본다)
        return result
    result = {**result, "marker": {"status": verdict["status"]}}
    from_nfs = (mgr.summary().get("storage") or {}).get("kind") == "nfs"
    if verdict["status"] == "mismatch":
        result.update(ok=False, cause="other_install")
    elif verdict["status"] == "missing" and from_nfs:
        result.update(ok=False, cause="marker_missing")
    return result


async def _receive_multipart(request: Request, target: Path) -> str:
    """multipart 본문의 `file` 부분을 target 에 흘려 쓴다(메모리·임시 파일에 모으지 않는다). 돌려주는 값: 파일 이름."""
    from python_multipart.multipart import MultipartParser, parse_options_header

    _, params = parse_options_header(request.headers.get("content-type", ""))
    boundary = params.get(b"boundary")
    if not boundary:
        raise UploadInvalid("boundary")
    state = {"field": b"", "value": b"", "headers": {}, "is_file": False, "name": "", "seen": False}

    with open(target, "wb") as out:
        def on_part_begin():
            state.update(field=b"", value=b"", headers={}, is_file=False)

        def on_header_field(data, start, end):
            state["field"] += data[start:end]

        def on_header_value(data, start, end):
            state["value"] += data[start:end]

        def on_header_end():
            state["headers"][state["field"].lower()] = state["value"]
            state.update(field=b"", value=b"")

        def on_headers_finished():
            _, opts = parse_options_header(state["headers"].get(b"content-disposition", b""))
            if opts.get(b"name") == b"file" and not state["seen"]:
                state.update(is_file=True, seen=True, name=(opts.get(b"filename") or b"").decode("utf-8", "replace"))

        def on_part_data(data, start, end):
            if state["is_file"]:
                out.write(data[start:end])

        def on_part_end():
            state["is_file"] = False

        parser = MultipartParser(boundary, {
            "on_part_begin": on_part_begin, "on_header_field": on_header_field, "on_header_value": on_header_value,
            "on_header_end": on_header_end, "on_headers_finished": on_headers_finished,
            "on_part_data": on_part_data, "on_part_end": on_part_end,
        })
        async for chunk in request.stream():
            if chunk:
                parser.write(chunk)
        parser.finalize()
    if not state["seen"]:
        raise UploadInvalid("no file part")
    return state["name"]


async def _receive_raw(request: Request, target: Path) -> str:
    with open(target, "wb") as out:
        async for chunk in request.stream():
            if chunk:
                out.write(chunk)
    return request.headers.get("x-file-name", "")


def register(app: FastAPI, svc, *, unlocked, session, stream) -> None:
    """마법사 앱에 복원 경로를 붙인다. `stream` 은 적용 상태의 SSE 처리기(설치와 같은 것)."""

    @app.exception_handler(RestoreError)
    async def _restore_error(request: Request, exc: RestoreError):
        return JSONResponse({"code": exc.code, "vars": exc.vars}, status_code=exc.status)

    @app.post("/api/restore/upload", dependencies=[Depends(unlocked)])
    async def upload(request: Request):
        mgr = manager(svc)
        length = request.headers.get("content-length", "")
        part = await run_in_threadpool(mgr.begin_upload, f"backup{ARCHIVE_SUFFIX}", int(length) if length.isdigit() else None)
        multipart = request.headers.get("content-type", "").lower().startswith("multipart/form-data")
        try:
            name = await (_receive_multipart(request, part) if multipart else _receive_raw(request, part))
        except ClientDisconnect:
            await run_in_threadpool(mgr.abort_upload, part)       # 올리다 취소했다 — 반쪽 파일을 남기지 않는다
            return JSONResponse({"code": "upload_aborted", "vars": {}}, status_code=400)
        except OSError as e:
            await run_in_threadpool(mgr.abort_upload, part)
            return JSONResponse({"code": "no_space", "vars": {"detail": e.strerror or ""}}, status_code=507)
        except Exception:  # noqa: BLE001 — 깨진 multipart 본문 등
            await run_in_threadpool(mgr.abort_upload, part)
            return JSONResponse({"code": "upload_invalid", "vars": {}}, status_code=400)
        return await run_in_threadpool(mgr.finish_upload, part, name)

    @app.post("/api/restore/path", dependencies=[Depends(unlocked)])
    def use_path(body: dict = Body(...)):
        return manager(svc).use_path(str(body.get("path") or ""))

    @app.post("/api/restore/password", dependencies=[Depends(unlocked)])
    def set_password(body: dict = Body(...)):
        return manager(svc).set_password(str(body.get("password") or ""))

    @app.get("/api/restore/file", dependencies=[Depends(unlocked)])
    def get_file():
        return manager(svc).info()

    @app.delete("/api/restore/file", dependencies=[Depends(unlocked)])
    def delete_file():
        mgr = manager(svc)
        if mgr.running:
            raise RestoreError(409, "apply_running")
        return mgr.discard()

    @app.get("/api/restore/review", dependencies=[Depends(unlocked)])
    def review():
        from app import api

        pre = svc.store.read("preflight.json")
        return manager(svc).review(detected_network=api.detected_facts(svc, pre).get("detected_network"))

    @app.post("/api/restore/apply", dependencies=[Depends(unlocked)], status_code=202)
    def apply(body: dict = Body(default={})):
        allowed = ("domain", "storage", "network", "proxy_addresses", "cert", "subnet")
        return manager(svc).start({k: body[k] for k in allowed if body.get(k) not in (None, "")})

    @app.get("/api/restore/apply", dependencies=[Depends(unlocked)])
    def get_apply():
        return svc.engine.status()

    @app.post("/api/restore/apply/retry", dependencies=[Depends(unlocked)], status_code=202)
    def retry(body: dict = Body(default={})):
        if svc.engine.running:
            raise RestoreError(409, "apply_running")
        if not svc.engine.retry(use_temporary_cert=bool(body.get("use_temporary_cert"))):
            raise RestoreError(409, "nothing_to_retry")
        return {"started": True}

    app.add_api_route("/api/restore/apply/stream", stream, methods=["GET"], dependencies=[Depends(session)])

