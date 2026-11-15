"""도구 응답 잘림 대책 — 완료 기준 1~8 + 라우터 주입.

files_search 는 색인 DB 대신 fsearch.search 를 가짜로 바꿔 돌린다(24건, 점수 동점이 페이지 경계에
걸리고, 200자 넘는 경로·큰 snippet·한글만 있는 이름 포함). 가짜는 매번 뒤섞은 뒤 실제 SQL 과 같은
키(점수↓, 수정시각↓, scope·rel_path·id↑)로 정렬한다 — 2차 기준이 있어야 순서가 고정된다는 것까지 본다.
"""

import contextlib
import json
import random
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.ai import tool_budget
from app.mcp import server
from app.mcp.tools import _common, collab_tool, files_tool

USER = SimpleNamespace(id="u1", username="alice", is_admin=False, display_name="앨리스",
                       email="a@x", timezone="Asia/Seoul")
META_KEYS = ["total", "returned", "has_more", "next_cursor", "truncated"]
BASE_T = datetime(2025, 2, 24, 13, 27, 5, 123456, tzinfo=timezone.utc)   # KST 22:27


def _row(i, *, name=None, sub="문서/작업", score=500.0, mtime=None, snippet=None, size=2_700_000):
    name = name or f"작업계획서_{i:02d}.hwp"
    return {
        "id": f"id-{i:02d}", "scope": "u1",
        "name": name, "path": f"my/{sub}/{name}", "parent": f"my/{sub}",
        "is_dir": False, "size": size, "modified_at": mtime or BASE_T - timedelta(days=i),
        "mime_type": None, "ext": "hwp", "score": score, "snippet": snippet,
    }


def _dataset() -> list[dict]:
    rows = []
    for i in range(24):
        rows.append(_row(i, score=900.0 - i * 10))
    # 점수·시각 동점 묶음 — 페이지 경계(5·10·15·20)에 걸치게 3..12, 14..21
    for i in range(3, 13):
        rows[i]["score"], rows[i]["modified_at"] = 777.0, BASE_T
    for i in range(14, 22):
        rows[i]["score"], rows[i]["modified_at"] = 333.0, BASE_T
    # 200자 넘는 경로
    rows[7]["path"] = "my/" + "/".join(["아주긴폴더이름입니다_" + str(k) for k in range(18)]) + "/작업계획서_긴경로.hwp"
    assert len(rows[7]["path"]) > 200
    # 큰 snippet
    rows[4]["snippet"] = "작업계획서 본문 " * 600
    rows[15]["snippet"] = "…방화벽 교체 작업계획서…"
    return rows


def _sort_key(r):
    return (-r["score"], -r["modified_at"].timestamp(), r["scope"], r["path"], r["id"])


@pytest.fixture()
def fake_search(monkeypatch):
    data = _dataset()
    calls: list = []

    async def search(db, q, scopes, viewer, limit=100, offset=0, name_only=False):
        calls.append({"q": q, "limit": limit, "offset": offset, "name_only": name_only})
        rows = list(data)
        random.shuffle(rows)            # DB 가 동점 순서를 보장하지 않는 상황
        rows.sort(key=_sort_key)        # build_query 와 같은 결정적 정렬
        return {"total": len(rows), "items": rows[offset:offset + limit], "query": q}

    @contextlib.asynccontextmanager
    async def session():
        yield None

    monkeypatch.setattr(files_tool.fsearch, "search", search)
    monkeypatch.setattr(files_tool, "async_session", session)
    return SimpleNamespace(data=data, calls=calls)


def _valid(obj) -> dict:
    text = json.dumps(obj, ensure_ascii=False)
    return json.loads(text)


async def _walk(limit=None, budget=None, query="작업계획서") -> list[str]:
    paths: list[str] = []
    cursor = ""
    scope = _common.fit_budget_scope(budget) if budget else contextlib.nullcontext()
    with scope:
        for _ in range(100):
            kw = {"limit": limit} if limit else {}
            r = await files_tool.files_search(USER, query=query, cursor=cursor, **kw)
            assert "error" not in r, r
            assert list(r)[:5] == META_KEYS
            if budget:
                assert _common.jlen(r) <= _common.fit_budget()
            paths += [x["path"] for x in r["results"]]
            if not r["has_more"]:
                assert r["next_cursor"] is None
                break
            cursor = r["next_cursor"]
    return paths


# ── 1·2. 기본 호출: 언제나 올바른 JSON, 페이지 정보 맨 앞 ───────────
async def test_default_call_valid_json_meta_first(fake_search):
    r = await files_tool.files_search(USER, query="작업계획서")
    back = _valid(r)
    assert list(back)[:5] == META_KEYS
    assert back["total"] == 24 and back["has_more"] is True
    assert fake_search.calls[-1]["limit"] == files_tool.FILES_SEARCH_DEFAULT_LIMIT == 20
    assert _common.jlen(r) <= _common.fit_budget()


async def test_compact_file_item_shape(fake_search):
    r = await files_tool.files_search(USER, query="작업계획서")
    first = r["results"][0]
    assert first == {"path": "my/문서/작업/작업계획서_00.hwp", "type": "file", "size": "2.6MB",
                     "modified": "2025-02-24 22:27"}           # 사용자 시간대(KST), 초·마이크로초 없음
    for it in r["results"]:
        assert not ({"name", "parent", "score", "size_bytes"} & set(it))
        assert "snippet" not in it or (it["snippet"] and len(it["snippet"]) <= 150)
    big = next(it for it in r["results"] if it["path"].endswith("_04.hwp"))
    assert len(big["snippet"]) == 150 and big["snippet"].endswith("…")
    # fields / verbose 로 예전 필드를 받는다
    r2 = await files_tool.files_search(USER, query="작업계획서", limit=2, fields="name,score,size_bytes")
    assert set(r2["results"][0]) >= {"name", "score", "size_bytes"} and r2["results"][0]["size_bytes"] == 2_700_000
    r3 = await files_tool.files_search(USER, query="작업계획서", limit=1, verbose=True)
    assert {"name", "parent", "score", "size_bytes", "modified_iso"} <= set(r3["results"][0])


def test_human_size_and_local_time():
    assert _common.human_size(2_700_000) == "2.6MB" and _common.human_size(512) == "512B"
    assert _common.human_size(1536) == "1.5KB"
    tz = _common.user_tz(SimpleNamespace(timezone=None))
    assert _common.local_time(BASE_T, tz) == "2025-02-24 22:27"
    assert _common.local_time(datetime(2025, 2, 24, 13, 27), tz) == "2025-02-24 22:27"   # naive = UTC


# ── 3·4·8. 커서를 끝까지 따라가면 중복·누락 없이 24개 ───────────────
async def test_follow_cursor_default_all_24_unique(fake_search):
    paths = await _walk()
    assert len(paths) == 24 and len(set(paths)) == 24
    assert paths == [r["path"] for r in sorted(fake_search.data, key=_sort_key)]


@pytest.mark.parametrize("limit", [5, 7, 10, 24])
async def test_ties_across_page_boundaries(fake_search, limit):
    # 동점 묶음(3..12, 14..21)이 5·7·10 단위 경계에 걸친다 — 결과는 항상 같은 순서·같은 집합
    paths = await _walk(limit=limit)
    assert paths == [r["path"] for r in sorted(fake_search.data, key=_sort_key)]


async def test_small_budget_long_path_and_snippet_still_complete(fake_search):
    # 예산이 작아 페이지마다 몇 건씩만 담겨도(truncated) 다 따라가면 24개
    paths = await _walk(budget=1500)
    assert len(paths) == 24 and len(set(paths)) == 24
    assert any(len(p) > 200 for p in paths)


async def test_truncated_page_next_cursor_points_after_last_kept(fake_search):
    with _common.fit_budget_scope(1500):
        r = await files_tool.files_search(USER, query="작업계획서")
    assert r["truncated"] is True and 0 < r["returned"] < 20
    off, e = _common.read_cursor(r["next_cursor"], _common.query_hash(
        "files_search", "작업계획서", sorted(["u1", "shared"]), False))
    assert e is None and off == r["returned"]


# ── 5. 항목 하나가 예산보다 커도 최소 1개 + 줄임 표시 ─────────────────
def test_single_oversized_item_kept_and_marked():
    items = [{"id": "x1", "path": "my/a.txt", "content": "가" * 10_000}, {"id": "x2", "path": "my/b.txt"}]
    r = _common.fit_page(items, offset=0, total=2, budget=1000, qhash="h")
    assert _common.jlen(r) <= 1000 and list(r)[:5] == META_KEYS
    assert r["returned"] == 1 and r["truncated"] is True and r["has_more"] is True
    it = r["results"][0]
    assert it["id"] == "x1" and it["path"] == "my/a.txt"            # 식별 필드는 지킨다
    assert it["shortened"] == ["content"] and it["content"].endswith("…")
    assert _common.read_cursor(r["next_cursor"], "h") == (1, None)


async def test_files_search_oversized_path_item_minimum_one(fake_search):
    fake_search.data[:] = [_row(0, name="가" * 900 + ".hwp")]
    with _common.fit_budget_scope(_common.MIN_BUDGET):
        r = await files_tool.files_search(USER, query="가")
    _valid(r)
    assert r["returned"] == 1 and r["truncated"] is True and r["results"][0]["shortened"] == ["path"]
    assert _common.jlen(r) <= _common.fit_budget()


async def test_chat_keeps_newest_and_cursor_is_oldest_kept(monkeypatch):
    msgs = [{"id": f"m{i}", "seq": i, "content": f"{i}번 " + "내용" * 400, "sender": {"display_name": "밥"},
             "created_at": f"2026-11-05T09:{i:02d}:00"} for i in range(10)]

    async def is_member(db, cid, uid):
        return True

    async def get_messages(db, cid, before=None, limit=50):
        pool = msgs if before is None else [m for m in msgs if m["seq"] < int(before[1:])]
        page = pool[-limit:]
        return page, len(pool) > len(page)

    @contextlib.asynccontextmanager
    async def session():
        yield None

    monkeypatch.setattr(collab_tool, "async_session", session)
    monkeypatch.setattr(collab_tool.chat_svc, "is_channel_member", is_member)
    monkeypatch.setattr(collab_tool.chat_svc, "get_messages", get_messages)
    seen: list[str] = []
    cursor = ""
    with _common.fit_budget_scope(3000):
        for _ in range(20):
            r = await collab_tool.chat_read_messages(USER, "c1", cursor=cursor)
            assert list(r)[:5] == META_KEYS and _common.jlen(r) <= _common.fit_budget()
            ids = [m["id"] for m in r["messages"]]
            if not seen:
                assert ids[-1] == "m9" and r["truncated"] is True        # 최신은 남긴다
            seen = ids + seen
            if not r["has_more"]:
                break
            assert r["next_cursor"] == ids[0]                           # 담은 것 중 가장 오래된 id
            cursor = r["next_cursor"]
    assert seen == [f"m{i}" for i in range(10)]                        # 건너뜀·중복 없음


# ── 6. 바깥 상한을 낮춰도 형식 유지 + truncated 또는 error ─────────────
async def test_lowered_outer_cap_via_execute_tool(fake_search):
    with _common.fit_budget_scope(2000):
        res = await server._execute_tool_core("files_search", {"query": "작업계획서"}, USER)
    assert res["ok"] is True
    assert len(json.dumps(res["result"], ensure_ascii=False)) <= 2000
    assert list(res["result"])[:5] == META_KEYS and res["result"]["truncated"] is True


async def test_mcp_cap_setting_used_without_ai_scope(fake_search, monkeypatch):
    monkeypatch.setattr(_common, "response_max_chars", lambda: 2000)
    res = await server._execute_tool_core("files_search", {"query": "작업계획서", "limit": 200}, USER)
    assert res["ok"] is True and len(json.dumps(res["result"], ensure_ascii=False)) <= 2000
    assert res["result"]["truncated"] is True


async def test_outer_safety_net_returns_response_too_large(monkeypatch):
    async def huge(user, **_):
        return {"id": "x" * 5000}          # 줄일 수 없는(식별) 필드만 큼

    monkeypatch.setitem(server.WORKSPACE_TOOLS, "zz_huge", server.Tool(
        name="zz_huge", description="t", parameters={"type": "object", "properties": {}}, handler=huge))
    monkeypatch.setattr(_common, "response_max_chars", lambda: 2000)
    res = await server._execute_tool_core("zz_huge", {}, USER)
    assert res["ok"] is False and res["error_code"] == "response_too_large"
    assert res["retryable"] is False and res["hint"] == _common.TOO_LARGE_HINT


def test_reducer_never_cuts_json_mid_string():
    # 페이지 정보가 뒤에 있는 옛 모양 + 긴 항목 100개 — 2,000자로 줄여도 올바른 JSON·커서 보정
    items = [{"path": f"my/{i:03d}_" + "가" * 60, "type": "file"} for i in range(100)]
    payload = {"results": items, "total": 100, "returned": 100, "has_more": False, "next_cursor": None}
    text = _common.fit_json_text(payload, 2000)
    assert len(text) <= 2000
    out = json.loads(text)
    assert out["truncated"] is True and out["has_more"] is True and out["returned"] == len(out["results"])
    assert _common.read_cursor(out["next_cursor"], "")[0] == out["returned"]


def test_reducer_window_and_untrusted_wrapper():
    # files_read 같은 본문 창: content 를 줄이고 next_offset 을 고친다(이어 읽기 유지)
    wrapped = {"untrusted": True, "source": "file_content",
               "data": {"path": "my/a.txt", "sha256": "f" * 64, "content": "본" * 50_000, "offset": 100,
                        "returned_chars": 50_000, "total_chars": 80_000, "truncated": True, "next_offset": 50_100}}
    text = _common.fit_json_text(wrapped, 12_000)
    out = json.loads(text)
    assert len(text) <= 12_000 and out["untrusted"] is True and out["source"] == "file_content"
    d = out["data"]
    assert d["next_offset"] == 100 + len(d["content"]) == 100 + d["returned_chars"] and d["truncated"] is True
    assert d["sha256"] == "f" * 64


def test_reducer_error_when_impossible():
    out = json.loads(_common.fit_json_text({"id": "가" * 5000}, 2000))
    assert out["error_code"] == "response_too_large" and out["hint"] == _common.TOO_LARGE_HINT


# ── 7. 예산은 글자 기준(바이트·\\uXXXX 아님) ─────────────────────────
async def test_budget_is_characters_not_bytes(fake_search):
    fake_search.data[:] = [_row(i, name="가나다라마바사아자차" * 3 + f"{i:02d}", sub="한글폴더") for i in range(24)]
    budget = 2000
    with _common.fit_budget_scope(budget + _common.FIT_MARGIN):
        r = await files_tool.files_search(USER, query="가나다")
    text = json.dumps(r, ensure_ascii=False)
    assert len(text) <= budget                                     # 글자 수로는 예산 안
    assert len(text.encode("utf-8")) > budget                      # 바이트로 쟀다면 넘쳤을 것
    # 바이트 기준이었다면 담을 수 있는 수(대략 1/3)보다 많이 담긴다
    per_item_bytes = len(json.dumps(r["results"][0], ensure_ascii=False).encode("utf-8"))
    assert r["returned"] > budget // per_item_bytes
    assert len(json.dumps(r, ensure_ascii=True)) > budget          # \uXXXX 로 쟀다면 6배


# ── 커서 ──────────────────────────────────────────────────────
async def test_cursor_bound_to_query(fake_search):
    r = await files_tool.files_search(USER, query="작업계획서", limit=5)
    nxt = r["next_cursor"]
    assert not nxt.isdigit()                                        # 불투명
    bad = await files_tool.files_search(USER, query="다른검색어", cursor=nxt)
    assert bad["error_code"] == "invalid_argument"
    bad2 = await files_tool.files_search(USER, query="작업계획서", cursor=nxt, name_only=True)
    assert bad2["error_code"] == "invalid_argument"
    junk = await files_tool.files_search(USER, query="작업계획서", cursor="!!!")
    assert junk["error_code"] == "invalid_argument"
    legacy = await files_tool.files_search(USER, query="작업계획서", cursor="5", limit=5)
    assert fake_search.calls[-1]["offset"] == 5 and legacy["returned"] == 5    # 옛 숫자 커서 하위호환


async def test_name_only_passed_to_search(fake_search):
    await files_tool.files_search(USER, query="작업계획서", name_only=True)
    assert fake_search.calls[-1]["name_only"] is True


def test_build_query_has_deterministic_order():
    from sqlalchemy.dialects import postgresql

    from app.files import search as fsearch

    stmt, _ = fsearch.build_query(["u1"], fsearch.parse_query("작업계획서"), 20, 0)
    sql = str(stmt.compile(dialect=postgresql.dialect()))
    order = sql[sql.index("ORDER BY"):]
    assert "file_index.mtime DESC" in order and "file_index.rel_path ASC" in order and "file_index.id ASC" in order
    stmt2, _ = fsearch.build_query(["u1"], fsearch.parse_query("작업계획서"), 20, 0, name_only=True)
    where = str(stmt2.compile(dialect=postgresql.dialect()))
    where = where[where.index("WHERE"):where.index("ORDER BY")]
    assert "lower(file_index.content)" not in where and "coalesce" not in where


# ── 라우터: 큰 도구 결과가 올바른 JSON·페이지 정보 맨 앞으로 모델에 들어간다 ─
def test_tool_result_budget_by_model():
    assert tool_budget.tool_result_budget(SimpleNamespace(kind="anthropic", model="claude-opus-5-5")) == 60_000
    assert tool_budget.tool_result_budget(SimpleNamespace(kind="anthropic", model="claude-sonnet-5-5")) == 60_000
    assert tool_budget.tool_result_budget(SimpleNamespace(kind="ollama", model="qwen3:8b")) == 6_000
    assert tool_budget.tool_result_budget(None, context_chars=4_000_000) == 60_000
    assert tool_budget.tool_result_budget(None, context_chars=32_000) == 4_000


async def test_router_injects_valid_json_meta_first(fake_search, monkeypatch, db):  # noqa: F811
    from app.ai import config as ai_config
    from app.ai import router as ai_router
    from app.ai.models import AIConversation
    from app.db.models import User

    @contextlib.asynccontextmanager
    async def _session():
        yield db
    monkeypatch.setattr(ai_router, "async_session", _session)
    conv = AIConversation(user_id="alice", title="t", tools_enabled=True)
    db.add(conv)
    await db.commit()
    alice = await db.get(User, "alice")
    seen: list = []
    budgets: list = []

    async def fake_stream(cfg, msgs, system=None, tools=None):
        seen.append(msgs)
        if len(seen) == 1:
            yield {"type": "tool_call", "name": "files_search", "args": json.dumps({"query": "작업계획서", "limit": 200})}
            yield {"type": "tool_call", "name": "zz_old", "args": "{}"}
        else:
            yield {"type": "text", "text": "끝"}
    monkeypatch.setattr(ai_router, "chat_stream", fake_stream)

    async def fake_exec(db_, name, args, user, **kw):
        budgets.append(_common.outer_cap())
        if name == "files_search":           # 실제 도구 — 라우터가 건 예산 안에서 스스로 맞춘다
            return {"ok": True, "result": await files_tool.files_search(USER, **args)}
        # 스스로 못 맞추는(옛 모양) 큰 결과 — 라우터가 구조를 지키며 줄인다
        items = [{"id": f"t{i}", "title": "가" * 200} for i in range(200)]
        return {"ok": True, "result": {"tasks": items, "total": 200, "returned": 200,
                                       "has_more": False, "next_cursor": None}}
    monkeypatch.setattr(ai_config, "ai_execute_tool", fake_exec)

    cfg = SimpleNamespace(model="qwen3", kind="ollama", base="")    # 소형 → 6,000자
    chunks = []
    async for c in ai_router._chat_event_stream(conv.id, alice, cfg, False, None,
                                               [{"function": {"name": "files_search"}}], True,
                                               [{"role": "user", "content": "작업계획서 찾아줘"}]):
        chunks.append(c)
    assert len(seen) == 2
    budget = tool_budget.tool_result_budget(cfg)
    assert budgets and all(b <= budget for b in budgets)
    turn = seen[1][-1]["content"]

    def block(name):
        mark = f"[{name}]\n"
        start = turn.index(mark) + len(mark)
        obj, end = json.JSONDecoder().raw_decode(turn, start)
        return obj, end - start

    fs_json, fs_len = block("files_search")
    assert list(fs_json)[:5] == META_KEYS and fs_json["total"] == 24 and fs_len <= budget
    old_json, old_len = block("zz_old")
    assert old_len <= budget
    assert old_json["truncated"] is True and old_json["returned"] == len(old_json["tasks"]) < 200
    assert _common.read_cursor(old_json["next_cursor"], "")[0] == old_json["returned"]


from tests.test_settings_security_p8 import db  # noqa: E402,F401 (픽스처 재사용)
