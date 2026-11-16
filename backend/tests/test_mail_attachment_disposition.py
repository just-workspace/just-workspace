"""메일 첨부 Content-Disposition — inline(미리보기) / attachment(다운로드) 분기와 파일 이름 인코딩."""

from app.mail.http_utils import attachment_disposition, inline_allowed


def test_default_is_attachment_with_ascii_and_utf8_names():
    v = attachment_disposition("킥오프-아젠다.pdf")
    assert v.startswith("attachment; ")
    # ASCII 폴백은 한글을 _ 로 치환
    assert 'filename="___-___.pdf"' in v
    # RFC 5987 UTF-8 이름은 퍼센트 인코딩
    assert "filename*=UTF-8''%ED%82%A5%EC%98%A4%ED%94%84-%EC%95%84%EC%A0%A0%EB%8B%A4.pdf" in v


def test_inline_for_preview():
    v = attachment_disposition("report.pdf", inline=True)
    assert v.startswith("inline; ")
    assert 'filename="report.pdf"' in v


def test_inline_with_safe_type_stays_inline():
    assert attachment_disposition("a.pdf", inline=True, content_type="application/pdf").startswith("inline; ")
    assert attachment_disposition("a.png", inline=True, content_type="IMAGE/PNG; name=a.png").startswith("inline; ")


def test_inline_with_unsafe_type_falls_back_to_attachment():
    # 발신자가 지정한 형식 — html/svg 를 앱 도메인에서 inline 으로 열면 저장형 XSS 발생
    for ct in ("text/html", "image/svg+xml", "application/xhtml+xml", "text/plain", "", "application/octet-stream"):
        assert attachment_disposition("x", inline=True, content_type=ct).startswith("attachment; "), ct


def test_inline_allowed():
    assert inline_allowed("image/jpeg")
    assert inline_allowed("application/pdf; charset=binary")
    assert not inline_allowed(None)
    assert not inline_allowed("text/html")
    assert not inline_allowed("image/svg+xml")


def test_strips_quotes_and_newlines():
    v = attachment_disposition('bad"name\r\n.txt')
    assert "\n" not in v and "\r" not in v
    assert 'filename="badname.txt"' in v
    assert "filename*=UTF-8''badname.txt" in v


def test_none_filename_falls_back():
    v = attachment_disposition(None)
    assert 'filename="attachment"' in v
