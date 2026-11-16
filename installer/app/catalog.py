"""구역 목록·메모리·포트 — `zones.json` 을 읽어 계산만 수행한다(선언을 본 모듈에 복제하지 않는다)."""

from __future__ import annotations

import math
from dataclasses import dataclass

MIN_MEMORY_MB = 4096          # 이 값 미만의 서버는 사전 점검에서 실패
# "4GB 서버"의 실제 MemTotal 은 커널·펌웨어 점유분을 제외한 3.7~3.9GB 이다. 1GB 단위로 올림한 값과 실측의 차이가
# 이 비율 이내이면 해당 올림값을 서버의 명목 메모리로 간주한다.
NOMINAL_TOLERANCE = 0.08


def nominal_memory_mb(actual_mb: int) -> int:
    """실측 메모리 → 명목 메모리(1GB 단위 올림, 차이가 8% 이내인 경우에만)."""
    if actual_mb <= 0:
        return 0
    rounded = math.ceil(actual_mb / 1024) * 1024
    if rounded - actual_mb <= rounded * NOMINAL_TOLERANCE:
        return rounded
    return actual_mb


@dataclass(frozen=True)
class MemoryVerdict:
    need_mb: int          # 선택한 구역의 권장 합계(기본 포함)
    have_mb: int          # 서버 실측
    nominal_mb: int       # 판정에 사용한 명목 값
    ok: bool
    below_minimum: bool

    def as_dict(self) -> dict:
        return {"need_mb": self.need_mb, "have_mb": self.have_mb, "nominal_mb": self.nominal_mb,
                "ok": self.ok, "below_minimum": self.below_minimum}


class Catalog:
    def __init__(self, data: dict):
        self.data = data
        self.core = data["core"]
        self._zones = {z["id"]: z for z in data.get("zones", [])}
        self._addons = {z["id"]: z for z in data.get("addons", [])}

    # ─── 목록 ───

    @property
    def zone_ids(self) -> list[str]:
        return list(self._zones)

    @property
    def addon_ids(self) -> list[str]:
        return list(self._addons)

    @property
    def presets(self) -> dict[str, list[str]]:
        return {k: list(v) for k, v in self.data.get("presets", {}).items()}

    def get(self, zone_id: str) -> dict:
        if zone_id == self.core["id"]:
            return self.core
        return self._zones.get(zone_id) or self._addons[zone_id]

    def known(self, zone_id: str) -> bool:
        return zone_id in self._zones or zone_id in self._addons

    def ordered(self, selected) -> list[str]:
        """선언 순서(zones 다음 addons)로 정렬, 중복 제거."""
        wanted = set(selected)
        return [z for z in (*self._zones, *self._addons) if z in wanted]

    # ─── 계산 ───

    def recommend_mb(self, selected) -> int:
        total = int(self.core["memory_mb"]["recommend"])
        for zone_id in self.ordered(selected):
            total += int(self.get(zone_id)["memory_mb"]["recommend"])
        return total

    def profiles(self, selected) -> list[str]:
        """선택한 구역의 compose 프로파일 합집합(선언 순서, 중복 제거)."""
        out: list[str] = []
        for zone_id in self.ordered(selected):
            for profile in self.get(zone_id).get("compose_profiles", []):
                if profile not in out:
                    out.append(profile)
        return out

    def services(self, zone_id: str) -> list[str]:
        return list(self.get(zone_id).get("services", []))

    def ports(self, selected) -> list[str]:
        out = list(self.core.get("ports", []))
        for zone_id in self.ordered(selected):
            for p in self.get(zone_id).get("ports", []):
                if p not in out:
                    out.append(p)
        return out

    def judge(self, selected, server_mb: int) -> MemoryVerdict:
        need = self.recommend_mb(selected)
        nominal = nominal_memory_mb(server_mb)
        return MemoryVerdict(
            need_mb=need,
            have_mb=server_mb,
            nominal_mb=nominal,
            ok=nominal >= need,
            below_minimum=nominal < MIN_MEMORY_MB,
        )

    def listing(self, selected, server_mb: int | None) -> dict:
        """`GET /api/zones` — 선언 그대로 + 서버 메모리 대비 판정."""
        chosen = set(selected)

        def row(z: dict, kind: str) -> dict:
            item = {
                "id": z["id"], "kind": kind, "name": z["name"], "summary": z["summary"],
                "memory_mb": z["memory_mb"], "ports": z.get("ports", []),
                "requires": z.get("requires", []), "wizard_step": z.get("wizard_step"),
                "selected": z["id"] in chosen,
            }
            if server_mb is not None:
                with_it = self.judge(chosen | {z["id"]}, server_mb)
                item["fits"] = with_it.ok
            return item

        out = {
            "version": self.data.get("version"),
            "core": {"id": self.core["id"], "name": self.core["name"], "summary": self.core["summary"],
                     "memory_mb": self.core["memory_mb"], "ports": self.core.get("ports", [])},
            "presets": self.presets,
            "zones": [row(z, "zone") for z in self._zones.values()],
            "addons": [row(z, "addon") for z in self._addons.values()],
        }
        if server_mb is not None:
            out["memory"] = self.judge(chosen, server_mb).as_dict()
            out["preset_fits"] = {name: self.judge(ids, server_mb).ok for name, ids in self.presets.items()}
        return out
