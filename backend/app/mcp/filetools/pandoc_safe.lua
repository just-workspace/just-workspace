-- md → docx 변환용 pandoc 필터: 그림을 글자로 바꾼다.
-- pandoc 은 docx 에 그림을 넣으려고 경로의 서버 파일을 읽거나 URL 을 내려받는다(파일 노출·SSRF).
-- 데비안 pandoc 의 --sandbox 는 자기 데이터 파일도 못 읽어 docx 를 못 만들므로, 필터로 그림 자체를 없앤다.
function Image(el)
  local alt = pandoc.utils.stringify(el.caption or el.content or {})
  if alt == "" then alt = "그림" end
  return pandoc.Str("[" .. alt .. "]")
end
