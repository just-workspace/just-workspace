"""소스 코드 링크의 주소(`JW_SOURCE_URL`) — `.env` 에 싣는 규칙과, 업데이트·구역 작업·복원을 거쳐도 남는가.

고쳐서 서비스하는 사람은 이 주소를 고친 소스로 바꿔 둔다(AGPL 13조). 설치 관리자에 한 번 준 값이
스택 파일을 다시 쓸 때마다 사라지면 안 된다.
"""

from app import envfile, render, update_restack
from tests.conftest import make_answers
from tests.test_restore import OLD_ENV, env_of, make, run_restore
from tests.test_zones import finish, installed

MINE = "https://git.example.com/acme/workspace"


def env(host) -> dict:
    return envfile.parse(host.paths.env_file.read_text(encoding="utf-8"))


def test_empty_value_is_not_written_at_all(monkeypatch, bundle, secrets, facts):
    monkeypatch.delenv("JW_SOURCE_URL", raising=False)
    text = render.render(make_answers(), secrets, facts, bundle, registry="localhost")[".env"]
    assert "JW_SOURCE_URL" not in text                                         # 빈 줄을 싣지 않는다
    for bad in ("", "   ", "javascript:alert(1)", "ftp://git.example.com/x", "https://git.example.com/a b"):
        monkeypatch.setenv("JW_SOURCE_URL", bad)
        assert "JW_SOURCE_URL" not in render.render(make_answers(), secrets, facts, bundle, registry="localhost")[".env"], bad
    monkeypatch.setenv("JW_SOURCE_URL", MINE)
    text = render.render(make_answers(), secrets, facts, bundle, registry="localhost")[".env"]
    assert f"\nJW_SOURCE_URL={MINE}\n" in text


def test_value_given_at_install_survives_later_stack_writes(tmp_path, monkeypatch):
    monkeypatch.setenv("JW_SOURCE_URL", MINE)
    host, svc = installed(tmp_path, preset="minimal", mail={})
    assert env(host)["JW_SOURCE_URL"] == MINE and svc.store.facts().source_url == MINE

    # 환경변수가 없는 곳에서 스택 파일을 다시 쓴다 — 업데이트의 switch 단계(새 이미지의 일회용 컨테이너)가 그렇다
    monkeypatch.delenv("JW_SOURCE_URL")
    update_restack.restack(host.paths, "localhost", "1.0.0")
    assert env(host)["JW_SOURCE_URL"] == MINE
    # 구역을 켜도(설치 관리자가 환경변수 없이 다시 떴다고 치자) 그대로다
    job = finish(svc, svc.zones.enable("chat", {}))
    assert job["status"] == "done", job["error"]
    assert env(host)["JW_SOURCE_URL"] == MINE

    # 새 값을 주면 그것으로 바뀌고, 그 값이 기억된다
    monkeypatch.setenv("JW_SOURCE_URL", MINE + "-v2")
    update_restack.restack(host.paths, "localhost", "1.0.0")
    assert env(host)["JW_SOURCE_URL"] == MINE + "-v2" and svc.store.facts().source_url == MINE + "-v2"


def test_install_without_a_value_stays_without_one(tmp_path, monkeypatch):
    monkeypatch.delenv("JW_SOURCE_URL", raising=False)
    host, svc = installed(tmp_path, preset="minimal", mail={})
    assert "JW_SOURCE_URL" not in env(host) and svc.store.facts().source_url is None
    update_restack.restack(host.paths, "localhost", "1.0.0")
    assert "JW_SOURCE_URL" not in env(host)


def test_value_written_by_an_older_installer_is_picked_up_from_the_env_file(tmp_path, monkeypatch):
    """이 기억(facts.source_url)이 없던 버전에서 올라온 설치 — `.env` 에 적힌 값을 이어 쓴다. 빈 줄(옛 형식)은 값이 아니다."""
    monkeypatch.delenv("JW_SOURCE_URL", raising=False)
    host, svc = installed(tmp_path, preset="minimal", mail={})
    path = host.paths.env_file
    path.write_text(path.read_text(encoding="utf-8") + "JW_SOURCE_URL=\n", encoding="utf-8")
    update_restack.restack(host.paths, "localhost", "1.0.0")
    assert "JW_SOURCE_URL" not in env(host)                                    # 옛 설치 관리자가 실은 빈 줄은 걷힌다

    path.write_text(path.read_text(encoding="utf-8") + f"JW_SOURCE_URL='{MINE}'\n", encoding="utf-8")
    update_restack.restack(host.paths, "localhost", "1.0.0")
    assert env(host)["JW_SOURCE_URL"] == MINE and svc.store.facts().source_url == MINE
    update_restack.restack(host.paths, "localhost", "1.0.0")                   # 한 번 더 써도 그대로
    assert env(host)["JW_SOURCE_URL"] == MINE


def test_restore_keeps_the_source_url_of_the_backup(tmp_path, monkeypatch):
    monkeypatch.delenv("JW_SOURCE_URL", raising=False)
    host, backup, svc, mgr = make(tmp_path, env={**OLD_ENV, "JW_SOURCE_URL": MINE})
    state = run_restore(svc, mgr, {"domain": "new.example.com", "storage": {"kind": "local"}})
    assert state["status"] == "done", state["error"]
    restored = env_of(host)
    assert restored["JW_SOURCE_URL"] == MINE and svc.store.facts().source_url == MINE
    assert host.paths.env_file.read_text(encoding="utf-8").count("JW_SOURCE_URL=") == 1    # "옮겨 온 설정"에 한 번 더 실리지 않는다
    # 복원 뒤의 구역 작업에서도 남는다
    update_restack.restack(host.paths, "localhost", "1.0.0")
    assert env_of(host)["JW_SOURCE_URL"] == MINE


def test_restore_prefers_the_value_given_to_the_new_installer(tmp_path, monkeypatch):
    monkeypatch.setenv("JW_SOURCE_URL", MINE + "-new")
    host, backup, svc, mgr = make(tmp_path, env={**OLD_ENV, "JW_SOURCE_URL": MINE})
    assert run_restore(svc, mgr, {"domain": "new.example.com", "storage": {"kind": "local"}})["status"] == "done"
    assert env_of(host)["JW_SOURCE_URL"] == MINE + "-new"


def test_restore_of_a_backup_without_the_value_or_with_a_bad_one(tmp_path, monkeypatch):
    monkeypatch.delenv("JW_SOURCE_URL", raising=False)
    for i, value in enumerate(("", "javascript:alert(1)")):
        host, backup, svc, mgr = make(tmp_path / str(i), env={**OLD_ENV, "JW_SOURCE_URL": value})
        assert run_restore(svc, mgr, {"domain": "new.example.com", "storage": {"kind": "local"}})["status"] == "done"
        assert "JW_SOURCE_URL" not in env_of(host), value
