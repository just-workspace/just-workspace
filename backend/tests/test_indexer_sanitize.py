"""색인 본문 정제 — NUL 한 글자에 색인 전체가 죽던 것.

Postgres text 컬럼에는 0x00 이 못 들어간다. 배치 INSERT 라서 파일 하나만 걸려도
그 주기 전체가 롤백됐고, 다음 주기에 같은 파일을 또 만나 무한히 실패했다.
"""

from app.files.indexer import _CTRL_RE


def test_nul_is_removed():
    assert _CTRL_RE.sub(" ", "a" + chr(0) + "b") == "a b"


def test_other_control_chars_removed():
    for cp in (0x01, 0x08, 0x0B, 0x0C, 0x1F, 0x7F):
        assert _CTRL_RE.sub("", chr(cp)) == "", f"U+{cp:04X} 가 안 걸렸다"


def test_whitespace_and_text_survive():
    # 탭/개행은 앞단 공백 정규화가 처리하므로 여기서 건드리면 안 된다
    assert _CTRL_RE.sub(" ", "\t\n") == "\t\n"
    assert _CTRL_RE.sub(" ", "한글 English 123 @#$") == "한글 English 123 @#$"


def test_eml_extension_is_indexed():
    """아카이브된 메일이 검색에 편입되려면 추출 대상이어야 한다."""
    import inspect
    from app.files import indexer

    src = inspect.getsource(indexer.extract_content)
    assert '".eml"' in src, ".eml 추출 분기가 없다"


def test_lone_surrogates_are_replaced():
    """cp949 등에서 잘못 디코딩된 잔해. json.dumps 가 터져 추출 묶음 전체가 날아갔다."""
    from app.files.indexer import _CTRL_RE  # noqa: F401
    bad = "정상" + chr(0xDAA8) + "텍스트"
    cleaned = bad.encode("utf-8", "replace").decode("utf-8", "replace")
    cleaned.encode("utf-8")          # 여기서 안 터져야 한다
    assert "정상" in cleaned and "텍스트" in cleaned


def test_extract_content_sanitizes_surrogates():
    import inspect
    from app.files import indexer
    src = inspect.getsource(indexer.extract_content)
    assert 'encode("utf-8", "replace")' in src, "서로게이트 정제가 빠졌다"
