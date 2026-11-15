"""회귀 — WOPI 잠금·file_id 에 소유자가 들어가 사용자끼리 충돌·탈취가 안 된다."""

import pytest
from fastapi import HTTPException

from app.wopi import locks
from app.wopi import router as wr
from app.wopi.tokens import create_wopi_token, validate_wopi_token


class _Redis:
    def __init__(self):
        self.kv = {}

    async def get(self, k):
        return self.kv.get(k)

    async def set(self, k, v, ex=None, nx=False):
        if nx and k in self.kv:
            return None
        self.kv[k] = v
        return True

    async def delete(self, *ks):
        for k in ks:
            self.kv.pop(k, None)


@pytest.fixture(autouse=True)
def redis(monkeypatch):
    r = _Redis()

    async def _get():
        return r
    monkeypatch.setattr(locks, "get_redis", _get)
    return r


PATH = "my/제목 없는 문서.docx"


def _tok(user, owner=None, perm="edit"):
    return create_wopi_token(user_id=user, user_name=user, virtual_path=PATH, permissions=perm, owner_id=owner)


async def _op(token, file_id, op, lock="", old=""):
    return await wr.wopi_lock_operations(file_id, None, access_token=token, x_wopi_override=op,
                                         x_wopi_lock=lock, x_wopi_old_lock=old, db=None)


async def test_same_name_documents_of_two_users_do_not_share_lock():
    a_fid, b_fid = wr._encode_file_id(PATH, "alice"), wr._encode_file_id(PATH, "bob")
    assert a_fid != b_fid
    r = await _op(_tok("alice"), a_fid, "LOCK", lock="L-alice")
    assert r.status_code == 200
    r = await _op(_tok("bob"), b_fid, "LOCK", lock="L-bob")   # 예전엔 409(같은 키)
    assert r.status_code == 200
    # 밥은 앨리스 잠금 id 를 볼 수도, 풀 수도 없다
    r = await _op(_tok("bob"), b_fid, "GET_LOCK")
    assert r.headers["X-WOPI-Lock"] == "L-bob"
    assert await locks.get_current_lock_id(locks.subject("alice", PATH)) == "L-alice"


async def test_token_cannot_be_used_on_other_owners_file_id():
    with pytest.raises(HTTPException) as e:
        await _op(_tok("bob"), wr._encode_file_id(PATH, "alice"), "UNLOCK", lock="x")
    assert e.value.status_code == 403


async def test_view_token_cannot_read_or_change_lock():
    fid = wr._encode_file_id(PATH, "alice")
    await _op(_tok("alice"), fid, "LOCK", lock="L-alice")
    viewer = _tok("guest-1", owner="alice", perm="view")
    r = await _op(viewer, fid, "GET_LOCK")
    assert r.headers["X-WOPI-Lock"] == ""
    for op in ("LOCK", "UNLOCK", "REFRESH_LOCK"):
        with pytest.raises(HTTPException) as e:
            await _op(viewer, fid, op, lock="L-evil", old="L-alice")
        assert e.value.status_code == 403
    assert await locks.get_current_lock_id(locks.subject("alice", PATH)) == "L-alice"


async def test_shared_editor_joins_owners_lock():
    fid = wr._encode_file_id(PATH, "alice")
    await _op(_tok("alice"), fid, "LOCK", lock="L-1")
    # 공유받은 편집자(토큰 owner=alice, 경로=소유자 기준)는 같은 잠금을 본다
    r = await _op(_tok("carol", owner="alice"), fid, "GET_LOCK")
    assert r.headers["X-WOPI-Lock"] == "L-1"


def test_legacy_file_id_still_decodes():
    import base64
    legacy = base64.urlsafe_b64encode(PATH.encode()).decode().rstrip("=")
    assert wr._decode_file_id_parts(legacy) == (None, PATH)
    data = validate_wopi_token(_tok("alice"))
    assert wr._check_token_file(data, legacy) == PATH
