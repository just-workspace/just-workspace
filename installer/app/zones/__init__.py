"""구역 설치 훅.

구역마다 세 가지 일을 한다. 구역 전용 모듈(`app/zones/<구역 id>.py`)이 있으면 그 모듈의 함수를,
없으면 기본 동작을 쓴다. 모듈은 필요한 함수만 정의하면 된다(없는 것은 기본 동작).

    install(ctx, zone_id)   컨테이너를 띄우고 초기 설정을 한다
    connect(ctx, zone_id)   워크스페이스와 잇는다(로그인 연동, 토큰, 앞단 경로 확인)
    remove(ctx, zone_id)    연결을 끊고 컨테이너를 멈춘다 — **데이터 볼륨은 남긴다**

기본 동작: 그 구역의 compose 서비스(`zones.json` 의 services 중 지금 프로파일에서 켜지는 것)를
`docker compose up -d` 로 띄우고 준비될 때까지 기다린다. connect 는 할 일이 없고, remove 는 멈추고 지운다.

`ctx` 는 app/engine.py 의 `Context` — 훅이 쓰는 것:
    ctx.zone_services(zone_id)  ctx.up(services)  ctx.wait_ready(container)  ctx.stop(services)
    ctx.docker.exec(container, argv, user=…, env_file=…, input=…)   인자 배열로만 부른다
    ctx.http.get(url, headers)  내부망의 서비스에 요청
    ctx.set_env(KEY=value)      `.env` 에 넣을 값(끝나면 backend 를 한 번 다시 띄운다)
    ctx.secrets()  ctx.answers  ctx.plan  ctx.log(text)  ctx.warn(key, **vars)
실패는 `StepError(cause, fix, **vars)` 로 알린다.

훅은 여러 번 불려도 같은 결과가 나와야 한다(실패한 단계부터 다시 돌린다).
"""

from __future__ import annotations

import importlib
from types import SimpleNamespace

ZONE_START_TIMEOUT = 300
PENDING = "pending.json"      # 구역 id → {"reason", "since"} — 켜져 있지만 연결(로그인 연동)을 걸지 못한 구역


def pending(store) -> dict:
    """연결이 보류된 구역. 인증서를 바꾼 뒤(또는 "다시 연결"로) 다시 시도한다."""
    return store.read(PENDING, {}) or {}


def mark_pending(ctx, zone_id: str, reason: str) -> None:
    from app.state import now_iso

    data = pending(ctx.store)
    data[zone_id] = {"reason": reason, "since": (data.get(zone_id) or {}).get("since") or now_iso()}
    ctx.store.write(PENDING, data)


def clear_pending(store, zone_id: str) -> None:
    data = pending(store)
    if data.pop(zone_id, None) is not None:
        store.write(PENDING, data)


def container_name(service: str) -> str:
    return f"ws-{service}"


def default_install(ctx, zone_id: str) -> None:
    services = ctx.zone_services(zone_id)
    if not services:
        ctx.log(f"{zone_id}: 띄울 컨테이너가 없습니다")
        return
    ctx.up(services)
    for service in services:
        ctx.wait_ready(container_name(service), ZONE_START_TIMEOUT)
    ctx.log(f"{zone_id}: {', '.join(services)} 시작")


def default_connect(ctx, zone_id: str) -> None:
    return None


def default_remove(ctx, zone_id: str) -> None:
    services = ctx.catalog.services(zone_id)
    ctx.stop(services)
    ctx.log(f"{zone_id}: {', '.join(services) or '(컨테이너 없음)'} 정지 — 데이터는 남겨 둡니다")


def get(zone_id: str) -> SimpleNamespace:
    """구역의 훅 묶음(install·connect·remove)."""
    if not zone_id.replace("_", "").isalnum():
        raise ValueError(f"구역 id 가 올바르지 않습니다: {zone_id!r}")
    try:
        module = importlib.import_module(f"app.zones.{zone_id}")
    except ModuleNotFoundError as e:
        if e.name != f"app.zones.{zone_id}":
            raise
        module = None
    return SimpleNamespace(
        install=getattr(module, "install", default_install),
        connect=getattr(module, "connect", default_connect),
        remove=getattr(module, "remove", default_remove),
    )
