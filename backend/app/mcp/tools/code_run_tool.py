"""code_run — 격리 Python 분석 실행(ws-sandbox). 쓰기 도구(low): 결과 파일을 사용자 저장소에 저장하기 때문.

* 샌드박스: 네트워크 없음·읽기 전용 루트·요청마다 상이한 비루트 uid·CPU/메모리/시간/출력 상한(docker-compose, sandbox/).
* 입력 파일은 백엔드가 **사용자 권한으로** 읽어 전달한다(샌드박스는 저장소에 접근할 수 없다). 코드에서는 ``input/<이름>``.
* 코드가 ``output/`` 에 기록한 파일(차트 png·xlsx·csv …)을 수신해 "AI 결과물" 폴더에 저장하고 {path,name,size,mime} 로 반환한다.
* 관리자 스위치: ai.gov.code_run_enabled(기본 활성화), MCP 노출 ai.gov.code_run_mcp(기본 비활성화 — 내장 AI 전용으로 시작).
  판정은 app.mcp.access.TOOL_SWITCH / MCP_OPT_IN.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone

from app.db.models import User
from app.mcp.filetools import containers, store
from app.mcp.filetools.toolkit import DST_FOLDER_PARAM, base, guard
from app.mcp.server import Tool, register
from app.mcp.tools._common import path_shared, shared_target  # noqa: F401 — 타인 노출 쓰기 판정
from app.mcp.tools._common import clamp, err, user_tz

CODE_MAX = 100_000
INPUT_MAX_FILES = 10
INPUT_MAX_BYTES = 30 * 1024 * 1024          # 합계
TIMEOUT_DEFAULT = 60
TIMEOUT_MAX = 120
OUT_TEXT = 20_000


def _clip(s: str, n: int = OUT_TEXT) -> tuple[str, bool]:
    s = s or ""
    if len(s) <= n:
        return s, False
    head = n * 3 // 4
    return s[:head] + f"\n… ({len(s) - n}자 생략) …\n" + s[-(n - head):], True


def _safe_input_name(name: str, used: set[str]) -> str:
    n = re.sub(r"[^\w.\- ()가-힣]", "_", os.path.basename(name)).strip(" .") or "input"
    stem, ext = os.path.splitext(n)
    out, i = n, 2
    while out.lower() in used:
        out = f"{stem} ({i}){ext}"
        i += 1
    used.add(out.lower())
    return out[:120]


@guard
async def code_run(user: User, code: str, input_paths: list | None = None, timeout_sec: int = TIMEOUT_DEFAULT,
                   save_outputs: bool = True, dst_folder: str = "", **_: object) -> dict:
    code = code or ""
    if not code.strip():
        return err("invalid_argument", "code 가 비었습니다")
    if len(code) > CODE_MAX:
        return err("too_large", f"코드가 너무 깁니다({len(code)}자, 상한 {CODE_MAX})")
    paths = [p for p in (input_paths or []) if isinstance(p, str) and p.strip()]
    if len(paths) > INPUT_MAX_FILES:
        return err("invalid_argument", f"입력 파일은 {INPUT_MAX_FILES}개까지입니다")
    files, total, used, mapping = [], 0, set(), []
    for p in paths:
        data, name = await store.read_input(user, p, max_bytes=INPUT_MAX_BYTES)
        total += len(data)
        if total > INPUT_MAX_BYTES:
            return err("too_large", f"입력 파일 총량이 너무 큽니다(상한 {INPUT_MAX_BYTES // 1024 // 1024}MB)")
        safe = _safe_input_name(name, used)
        files.append((safe, data))
        mapping.append({"path": p.strip("/"), "as": f"input/{safe}"})
    timeout = clamp(timeout_sec, 5, TIMEOUT_MAX, TIMEOUT_DEFAULT)
    r = await containers.sandbox_run(code, files, timeout)
    stdout, so_cut = _clip(str(r.get("stdout") or ""))
    stderr, se_cut = _clip(str(r.get("stderr") or ""), OUT_TEXT // 2)
    out: dict = {
        "exit_code": r.get("exit_code"),
        "timed_out": bool(r.get("timed_out")),
        "duration_ms": r.get("duration_ms"),
        "stdout": stdout,
        "stderr": stderr,
    }
    if so_cut or r.get("stdout_truncated"):
        out["stdout_truncated"] = True
    if se_cut or r.get("stderr_truncated"):
        out["stderr_truncated"] = True
    if r.get("killed_reason"):
        out["killed_reason"] = r["killed_reason"]
    if mapping:
        out["inputs"] = mapping
    produced = r.get("files") or []
    if r.get("files_skipped"):
        out["files_skipped"] = r["files_skipped"]
    if produced and save_outputs:
        outs = [store.OutFile(store.clean_name(f["name"].replace("/", " - "), "output"), f["data"])
                for f in produced]
        stamp = datetime.now(timezone.utc).astimezone(user_tz(user)).strftime("%H%M%S")
        saved = await store.save_outputs(user, outs, dst_folder=dst_folder, group_name=f"코드 실행 결과 {stamp}")
        out.update({k: v for k, v in saved.items() if k not in ("label",)})
    elif produced:
        out["files"] = [{"name": f["name"], "size": f["size"], "saved": False} for f in produced]
    return out


def _sum(args: dict) -> str:
    code = str(args.get("code") or "").strip().splitlines()
    first = next((ln for ln in code if ln.strip() and not ln.strip().startswith("#")), code[0] if code else "")
    ins = args.get("input_paths") or []
    extra = f" · 입력 {', '.join(base(p) for p in ins[:3])}" + (" 외" if len(ins) > 3 else "") if ins else ""
    return f"Python 실행 · {len(code)}줄 · {first[:60]}{extra}"


def _prev(args: dict) -> list[dict]:
    rows = [{"field": "code", "label": "코드", "before": None, "after": str(args.get("code") or "")[:4000]}]
    if args.get("input_paths"):
        rows.append({"field": "input_paths", "label": "입력 파일", "before": None,
                     "after": ", ".join(base(p) for p in args["input_paths"])})
    return rows


register(Tool(
    name="code_run",
    title="Python 분석 실행",
    description=(
        "Run Python 3 code in an isolated sandbox for data analysis: pandas, numpy, scipy, statsmodels, "
        "scikit-learn, matplotlib/seaborn (Korean font set; use plt.savefig), openpyxl/xlsxwriter, python-docx, "
        "python-pptx, reportlab, pypdf, Pillow. No network access. Files from `input_paths` are copied to "
        "`input/<file name>` (read with e.g. pd.read_excel('input/sales.xlsx')). Write result files (charts, "
        "xlsx, csv…) into `output/` — they are saved to the user's files and returned as `files` "
        "[{path, name, size, mime}]. Print what the user should see; stdout/stderr come back (long output is "
        f"shortened). Time limit default {TIMEOUT_DEFAULT}s (max {TIMEOUT_MAX}s), memory ~1.5GB, each run starts "
        "fresh (no state between runs)."
    ),
    scope="mcp:write", risk="low",
    parameters={"type": "object", "properties": {
        "code": {"type": "string", "description": "Python 3 source to run.", "x-label": "코드",
                 "x-editable": True, "x-multiline": True},
        "input_paths": {"type": "array", "items": {"type": "string"},
                        "description": f"Virtual paths of files to give the code (≤{INPUT_MAX_FILES}, ≤30MB total).",
                        "x-label": "입력 파일"},
        "timeout_sec": {"type": "integer", "default": TIMEOUT_DEFAULT, "description": f"5-{TIMEOUT_MAX} seconds.",
                        "x-label": "시간 제한(초)", "x-editable": True},
        "save_outputs": {"type": "boolean", "default": True, "description": "Save files from output/ to the user's files."},
        "dst_folder": DST_FOLDER_PARAM,
    }, "required": ["code"]},
    visible_for=shared_target("dst_folder"),   # 공유 영역이면 타인 노출 쓰기(외부 내용을 읽은 뒤에는 확인을 요청한다)
    # 입력 파일(타인이 작성한 것일 수 있다)을 읽은 코드의 stdout 이 모델에 반환된다 → 내장 AI 대화 표시
    conv_untrusted=lambda a: bool(a.get("input_paths")),
    handler=code_run, summarizer=_sum, previewer=_prev,
))
