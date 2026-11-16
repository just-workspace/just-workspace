"""인증서의 내부 API — `/internal/cert*` (8444, 공유 키 + 내부 대역). 동작은 app/certctl.py 가 한다.

| 메서드·경로 | 하는 일 |
|---|---|
| `GET /internal/cert` | 지금 쓰는 인증서 — 종류·임시 여부·만료일·발급자·이름, 인증서 때문에 보류된 구역 연결 |
| `POST /internal/cert/reissue` `{"mode": "auto"}` 또는 `{"mode": "upload", "cert", "key", "ca"?}` | 다시 발급 / 올린 인증서로 교체(202 + 작업) |
| `POST /internal/cert/ca` `{"ca"}` | 올린 인증서를 쓰는 설치에 발급 CA 인증서만 더한다(202 + 작업). `{"ca": ""}` 는 따로 올린 CA 를 걷어 낸다 |
| `POST /internal/zones/<id>/reconnect` | 보류된 구역 연결을 다시 시도(202 + 작업) |
"""

from __future__ import annotations

from fastapi import Body, Depends, FastAPI

from app.certctl import CertManager


def manager(svc) -> CertManager:
    if "cert" not in svc.cache:
        svc.cache["cert"] = CertManager(svc.engine, svc.zones)
    return svc.cache["cert"]


def register(app: FastAPI, svc, *, keyed) -> None:
    @app.get("/internal/cert", dependencies=[Depends(keyed)])
    def cert_status():
        return manager(svc).status()

    @app.post("/internal/cert/reissue", dependencies=[Depends(keyed)], status_code=202)
    def cert_reissue(body: dict = Body(default={})):
        return manager(svc).reissue(body)

    @app.post("/internal/cert/ca", dependencies=[Depends(keyed)], status_code=202)
    def cert_ca(body: dict = Body(default={})):
        return manager(svc).set_ca(body)

    @app.post("/internal/zones/{zone_id}/reconnect", dependencies=[Depends(keyed)], status_code=202)
    def zone_reconnect(zone_id: str):
        return svc.zones.reconnect(zone_id)
