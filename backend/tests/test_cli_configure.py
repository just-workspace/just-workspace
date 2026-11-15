"""`python -m app.cli configure` — 설치 관리자가 DB 에 저장되는 설정(SMTP 보안 방식, AI 제공자)을 넣는다."""

import io

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import cli
from app.admin.settings import get_setting


@pytest.fixture()
async def db(db_engine, monkeypatch):
    import app.db.session as session_mod

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(session_mod, "engine", db_engine)
    monkeypatch.setattr(session_mod, "async_session", factory)
    return factory


async def test_configure_sets_smtp_security_and_ai(db):
    done = await cli.configure({
        "settings": {"smtp.security": "ssl"},
        "ai": {"kind": "openai", "model": "some-model", "base_url": "", "api_key": "sk-test-value"},
    })
    assert done == ["smtp.security", "ai"]
    async with db() as s:
        assert await get_setting(s, "smtp.security") == "ssl"
        assert await get_setting(s, "ai.provider.kind") == "openai"
        assert await get_setting(s, "ai.provider.model") == "some-model"
        stored = await get_setting(s, "ai.provider.api_key")
        assert stored and "sk-test-value" not in stored          # 키는 암호화해 저장한다


async def test_configure_rejects_unknown_settings(db):
    with pytest.raises(ValueError):
        await cli.configure({"settings": {"general.domain": "x"}})
    with pytest.raises(ValueError):
        await cli.configure({"settings": {"smtp.security": "plain"}})
    with pytest.raises(ValueError):
        await cli.configure({"ai": {"kind": "nope", "model": "m"}})
    assert await cli.configure({}) == []


def test_configure_command_reads_stdin_and_hides_values(monkeypatch, capsys):
    async def fake(payload):
        assert payload == {"ai": {"kind": "openai", "api_key": "sk-secret"}}
        return ["ai"]

    monkeypatch.setattr(cli, "configure", fake)
    monkeypatch.setattr("sys.stdin", io.StringIO('{"ai": {"kind": "openai", "api_key": "sk-secret"}}'))
    assert cli.main(["configure"]) == 0
    out = capsys.readouterr()
    assert "configured: ai" in out.out and "sk-secret" not in out.out + out.err

    monkeypatch.setattr("sys.stdin", io.StringIO("[1, 2]"))
    assert cli.main(["configure"]) == 2
