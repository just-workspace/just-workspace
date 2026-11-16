"""`docker-compose.yml` 에서 이미지 목록을 추출한다 — 자체 빌드 이미지와 외부 이미지(third-party), 구역 매핑.

표준 라이브러리에 YAML 파서가 없으므로 **필요한 범위만** 파싱한다:
`services:` 아래 각 서비스의 `image`, `build`(문자열 또는 `context`·`dockerfile`·`target`), `profiles`.
그 밖의 항목은 들여쓰기만 확인하고 건너뛴다. 파싱 대상 항목에 앵커·별칭·여러 줄 값이 사용되면 오류 없이 잘못된 결과를 내는 대신
ComposeError 로 중단한다. (테스트가 PyYAML 결과와 대조하여 본 파싱 동작을 고정한다.)

- 자체 빌드 이미지 = `build:` 가 있는 서비스
- 외부 이미지 = `build:` 없이 `image:` 만 있는 서비스
- `${VAR:-기본값}` 은 주어진 환경으로 전개한다(없으면 기본값)
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping

DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


class ComposeError(ValueError):
    """compose 파일 읽기 실패 또는 릴리스에 사용할 수 없는 내용."""


# ── 변수 전개 ────────────────────────────────────────────────


def expand(text: str, env: Mapping[str, str] | None = None) -> str:
    """compose 의 변수 표기(`$VAR`, `${VAR}`, `${VAR:-x}`, `${VAR-x}`, `${VAR:?msg}`, `${VAR:+x}`, `$$`)를 전개한다."""
    env = env or {}
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch != "$":
            out.append(ch)
            i += 1
            continue
        if text.startswith("$$", i):
            out.append("$")
            i += 2
            continue
        if text.startswith("${", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if text.startswith("${", j):
                    depth += 1
                    j += 2
                    continue
                if text[j] == "}":
                    depth -= 1
                j += 1
            if depth:
                raise ComposeError(f"닫히지 않은 변수 표기: {text!r}")
            out.append(_expand_braced(text[i + 2 : j - 1], env))
            i = j
            continue
        m = re.compile(r"[A-Za-z_][A-Za-z0-9_]*").match(text, i + 1)
        if m:
            out.append(env.get(m.group(0), ""))
            i = m.end()
        else:
            out.append("$")
            i += 1
    return "".join(out)


def _expand_braced(body: str, env: Mapping[str, str]) -> str:
    m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", body)
    if not m:
        raise ComposeError(f"변수 이름이 아니다: ${{{body}}}")
    name, rest = m.group(0), body[m.end():]
    value = env.get(name)
    if not rest:
        return value or ""
    for op in (":-", "-", ":?", "?", ":+", "+"):
        if rest.startswith(op):
            arg = rest[len(op):]
            unset = value is None or (op.startswith(":") and value == "")
            if op in (":-", "-"):
                return expand(arg, env) if unset else value
            if op in (":?", "?"):
                if unset:
                    raise ComposeError(f"필수 변수 {name} 가 없다: {arg}")
                return value
            return "" if unset else expand(arg, env)
    raise ComposeError(f"모르는 변수 표기: ${{{body}}}")


# ── 필요 범위의 YAML 파싱 ────────────────────────────────────


def _strip_comment(line: str) -> str:
    quote = ""
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i].rstrip()
    return line.rstrip()


def _scalar(raw: str, where: str) -> str:
    value = raw.strip()
    if not value:
        raise ComposeError(f"{where}: 값이 비어 있다")
    if value[0] in "&*|>{[!":
        raise ComposeError(f"{where}: 이 표기는 읽지 않는다({value[:12]}…)")
    if value[0] in "\"'":
        if len(value) < 2 or value[-1] != value[0]:
            raise ComposeError(f"{where}: 따옴표가 닫히지 않았다")
        inner = value[1:-1]
        if value[0] == '"' and "\\" in inner:
            raise ComposeError(f"{where}: 이스케이프가 든 문자열은 읽지 않는다")
        return inner.replace("''", "'") if value[0] == "'" else inner
    return value


def _inline_list(raw: str, where: str) -> list[str]:
    value = raw.strip()
    if not (value.startswith("[") and value.endswith("]")):
        raise ComposeError(f"{where}: 목록 표기가 아니다")
    inner = value[1:-1].strip()
    return [_scalar(part, where) for part in inner.split(",")] if inner else []


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def parse_services(text: str) -> dict[str, dict[str, Any]]:
    """서비스 이름 → `{"image": str|None, "build": dict|None, "profiles": [str]}` (값은 전개 전 원문)."""
    if "\t" in text.replace("\r", ""):
        for no, line in enumerate(text.splitlines(), 1):
            if "\t" in line[: len(line) - len(line.lstrip())]:
                raise ComposeError(f"{no}행: 탭 들여쓰기는 읽지 않는다")
    lines = [(no, _strip_comment(raw)) for no, raw in enumerate(text.splitlines(), 1)]
    lines = [(no, ln) for no, ln in lines if ln.strip()]

    start = next((i for i, (_, ln) in enumerate(lines) if ln == "services:"), None)
    if start is None:
        raise ComposeError("최상위 `services:` 가 없다")
    body: list[tuple[int, str]] = []
    for no, ln in lines[start + 1 :]:
        if _indent(ln) == 0:
            break
        body.append((no, ln))
    if not body:
        raise ComposeError("`services:` 가 비어 있다")

    svc_indent = _indent(body[0][1])
    services: dict[str, dict[str, Any]] = {}
    current: dict[str, Any] | None = None
    key_indent: int | None = None
    block: str | None = None           # 현재 파싱 중인 하위 블록: "build" | "profiles" | None
    block_indent: int | None = None

    for no, ln in body:
        ind = _indent(ln)
        stripped = ln.strip()
        if ind < svc_indent:
            raise ComposeError(f"{no}행: 들여쓰기를 해석하지 못했다")
        if ind == svc_indent:
            m = re.fullmatch(r"([A-Za-z0-9._-]+):", stripped)
            if not m:
                raise ComposeError(f"{no}행: 서비스 이름 줄이 아니다: {stripped!r}")
            name = m.group(1)
            if name in services:
                raise ComposeError(f"{no}행: 서비스가 두 번 나온다: {name}")
            current = {"image": None, "build": None, "profiles": []}
            services[name] = current
            key_indent, block, block_indent = None, None, None
            continue
        if current is None:
            raise ComposeError(f"{no}행: 서비스 밖의 줄")
        if key_indent is None:
            key_indent = ind
        if ind == key_indent:
            block, block_indent = None, None
            m = re.match(r"([A-Za-z0-9_.-]+):(?:\s+(.*))?$", stripped)
            if not m:
                if stripped.startswith("<<"):
                    raise ComposeError(f"{no}행: 병합 키(<<)는 읽지 않는다")
                continue
            key, value = m.group(1), (m.group(2) or "")
            where = f"{no}행 {key}"
            if key == "image":
                current["image"] = _scalar(value, where)
            elif key == "build":
                if value:
                    current["build"] = {"context": _scalar(value, where)}
                else:
                    current["build"] = {}
                    block = "build"
            elif key == "profiles":
                if value:
                    current["profiles"] = _inline_list(value, where)
                else:
                    block = "profiles"
            continue
        if ind < key_indent:
            raise ComposeError(f"{no}행: 들여쓰기를 해석하지 못했다")
        if block is None:
            continue
        if block_indent is None:
            block_indent = ind
        if ind != block_indent:
            continue                    # build.args 등 더 깊은 항목
        if block == "build":
            m = re.match(r"([A-Za-z0-9_.-]+):(?:\s+(.*))?$", stripped)
            if m and m.group(1) in ("context", "dockerfile", "target"):
                current["build"][m.group(1)] = _scalar(m.group(2) or "", f"{no}행 build.{m.group(1)}")
        elif block == "profiles":
            if not stripped.startswith("- "):
                raise ComposeError(f"{no}행: profiles 목록 줄이 아니다")
            current["profiles"].append(_scalar(stripped[2:], f"{no}행 profiles"))

    for name, svc in services.items():
        if svc["build"] is not None and "context" not in svc["build"]:
            raise ComposeError(f"{name}: build 에 context 가 없다")
    return services


# ── 이미지 참조 ──────────────────────────────────────────────


@dataclass(frozen=True)
class ImageRef:
    repository: str
    tag: str | None = None
    digest: str | None = None

    @classmethod
    def parse(cls, text: str) -> "ImageRef":
        ref = text.strip()
        if not ref or any(c.isspace() for c in ref) or "$" in ref:
            raise ComposeError(f"이미지 참조가 아니다: {text!r}")
        digest = None
        if "@" in ref:
            ref, digest = ref.split("@", 1)
            if not DIGEST.fullmatch(digest):
                raise ComposeError(f"다이제스트 꼴이 아니다: {text!r}")
        tag = None
        slash = ref.rfind("/")
        colon = ref.rfind(":")
        if colon > slash:
            ref, tag = ref[:colon], ref[colon + 1 :]
            if not tag:
                raise ComposeError(f"태그가 비어 있다: {text!r}")
        if not ref:
            raise ComposeError(f"저장소 이름이 없다: {text!r}")
        return cls(ref, tag, digest)

    @property
    def pinned(self) -> bool:
        return self.digest is not None

    def by_digest(self) -> str:
        """`저장소@sha256:…` (태그 제외)."""
        if not self.digest:
            raise ComposeError(f"다이제스트가 없다: {self}")
        return f"{self.repository}@{self.digest}"

    def by_tag(self) -> str:
        return f"{self.repository}:{self.tag}" if self.tag else self.repository

    def __str__(self) -> str:
        text = self.by_tag()
        return f"{text}@{self.digest}" if self.digest else text


@dataclass(frozen=True)
class BuildSpec:
    context: str
    dockerfile: str = "Dockerfile"
    target: str | None = None

    @property
    def dockerfile_path(self) -> str:
        """리포 루트 기준 Dockerfile 경로."""
        return f"{_norm(self.context)}/{self.dockerfile}"


def _norm(path: str) -> str:
    path = path.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path.rstrip("/") or "."


@dataclass(frozen=True)
class ComposeImage:
    service: str
    ref: ImageRef
    build: BuildSpec | None
    profiles: tuple[str, ...]

    @property
    def ours(self) -> bool:
        return self.build is not None


def read_images(text: str, env: Mapping[str, str] | None = None) -> list[ComposeImage]:
    """compose 원문 → 서비스별 이미지(파일 내 출현 순서)."""
    out: list[ComposeImage] = []
    for name, svc in parse_services(text).items():
        if svc["image"] is None:
            if svc["build"] is None:
                raise ComposeError(f"{name}: image 도 build 도 없다")
            raise ComposeError(f"{name}: build 만 있고 image 가 없다 — 릴리스에 실을 이름을 정할 수 없다")
        ref = ImageRef.parse(expand(svc["image"], env))
        build = None
        if svc["build"] is not None:
            b = svc["build"]
            build = BuildSpec(_norm(expand(b["context"], env)), expand(b.get("dockerfile", "Dockerfile"), env), b.get("target"))
        out.append(ComposeImage(name, ref, build, tuple(svc["profiles"])))
    return out


def own_images(images: list[ComposeImage]) -> list[ComposeImage]:
    return [i for i in images if i.ours]


def third_party_images(images: list[ComposeImage]) -> list[ComposeImage]:
    return [i for i in images if not i.ours]


def unpinned_third_party(images: list[ComposeImage]) -> list[ComposeImage]:
    """다이제스트 없이 태그로만(또는 태그도 없이) 고정된 외부 이미지."""
    return [i for i in third_party_images(images) if not i.ref.pinned]


# ── 구역 ─────────────────────────────────────────────────────


def service_zones(zones: Mapping[str, Any]) -> dict[str, str]:
    """zones.json 내용 → 서비스 이름 → 구역 id (`core`, 구역, 부가 구역)."""
    out: dict[str, str] = {}
    groups = [zones.get("core") or {}] + list(zones.get("zones") or []) + list(zones.get("addons") or [])
    for group in groups:
        zone_id = group.get("id")
        if not isinstance(zone_id, str) or not zone_id:
            raise ComposeError("zones.json: id 없는 구역이 있다")
        for service in group.get("services") or []:
            if service in out:
                raise ComposeError(f"zones.json: 서비스 {service} 가 두 구역({out[service]}, {zone_id})에 있다")
            out[service] = zone_id
    return out


Resolver = Callable[[ImageRef], str]
"""태그로만 고정된 이미지의 다이제스트(`sha256:…`)를 알아내는 함수."""


def third_party_by_zone(
    images: list[ComposeImage],
    zones: Mapping[str, Any],
    *,
    pins: Mapping[str, str] | None = None,
    resolver: Resolver | None = None,
) -> dict[str, dict[str, str]]:
    """외부 이미지를 구역별로 분류: `{구역: {서비스: "저장소@sha256:…"}}`.

    다이제스트가 없는 이미지는 `pins`(`"저장소:태그"` → `"sha256:…"`)나 `resolver` 로 보완한다.
    둘 다 보완 불가 시 ComposeError(목록 포함)로 중단한다 — 태그는 참조 대상이 변경될 수 있어 릴리스에 포함하지 않는다.
    어느 구역에도 속하지 않은 외부 이미지도 오류다(zones.json 에 서비스를 추가해야 한다).
    """
    zone_of = service_zones(zones)
    pins = pins or {}
    out: dict[str, dict[str, str]] = {}
    missing: list[str] = []
    unzoned: list[str] = []
    for image in third_party_images(images):
        zone = zone_of.get(image.service)
        if zone is None:
            unzoned.append(image.service)
            continue
        ref = image.ref
        digest = ref.digest
        if digest is None:
            digest = pins.get(ref.by_tag())
            if digest is None and resolver is not None:
                digest = resolver(ref)
            if digest is None:
                missing.append(f"{image.service} ({ref.by_tag()})")
                continue
            if not DIGEST.fullmatch(digest):
                raise ComposeError(f"{image.service}: 채운 다이제스트의 꼴이 틀리다: {digest!r}")
        out.setdefault(zone, {})[image.service] = f"{ref.repository}@{digest}"
    if unzoned:
        raise ComposeError("어느 구역에도 없는 남의 이미지: " + ", ".join(unzoned))
    if missing:
        raise ComposeError("다이제스트 없이 태그로만 고정된 남의 이미지: " + ", ".join(missing))
    return out
