"""Git 화면 링크·클론 주소는 브라우저용 공개 주소여야 한다.

Gitea 는 API 요청 Host(내부 http://gitea:3000)로 html_url·clone_url·avatar_url 을 만들어 준다 —
그대로 내려보내면 "Gitea에서 열기"·원본·PR·클론 HTTPS 주소가 브라우저에서 안 열린다(회귀)."""

from app.config import get_settings
from app.git import router as git_router

settings = get_settings()


def test_internal_host_rewritten_to_external(monkeypatch):
    monkeypatch.setattr(settings, "gitea_url", "http://gitea:3000")
    monkeypatch.setattr(settings, "gitea_external_url", "https://ws.example.com/git/")
    f = git_router._public_url
    assert f("http://gitea:3000/git/o/r") == "https://ws.example.com/git/o/r"
    assert f("http://gitea:3000/git/o/r.git") == "https://ws.example.com/git/o/r.git"
    assert f("http://gitea:3000/git/avatars/abc?size=40") == "https://ws.example.com/git/avatars/abc?size=40"
    # 이미 공개 주소·다른 호스트·빈 값은 그대로
    assert f("https://ws.example.com/git/o/r") == "https://ws.example.com/git/o/r"
    assert f("https://secure.gravatar.com/avatar/x") == "https://secure.gravatar.com/avatar/x"
    assert f("") == "" and f(None) == ""


def test_external_falls_back_to_app_url(monkeypatch):
    monkeypatch.setattr(settings, "gitea_url", "http://gitea:3000")
    monkeypatch.setattr(settings, "gitea_external_url", "")
    monkeypatch.setattr(settings, "app_url", "https://app.example.org")
    assert git_router._public_url("http://gitea:3000/git/o/r") == "https://app.example.org/git/o/r"


def test_repo_summary_maps_public_urls(monkeypatch):
    monkeypatch.setattr(settings, "gitea_url", "http://gitea:3000")
    monkeypatch.setattr(settings, "gitea_external_url", "https://ws.example.com/git/")
    s = git_router._map_repo_summary({
        "id": 1, "name": "r", "full_name": "o/r",
        "owner": {"login": "o", "avatar_url": "http://gitea:3000/git/avatars/a"},
        "html_url": "http://gitea:3000/git/o/r",
    })
    assert s.html_url == "https://ws.example.com/git/o/r"
    assert s.owner.avatar_url == "https://ws.example.com/git/avatars/a"
