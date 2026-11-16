-- dovecot 이 IMAP/SMTP 로그인마다 워크스페이스 백엔드에 비밀번호 검증을 요청한다.
--
-- 메일 비밀번호를 별도 보관하고 push 로 동기화하는 방식은 구조적으로 불일치가 발생한다
-- (push 실패가 드러나지 않고, 승인 시점에는 평문을 알 수 없다). 따라서 단일 출처만 조회한다.
--
-- 본문은 퍼센트 인코딩이다. JSON 생성에는 백슬래시 이스케이프가 필요한데
-- 이스케이프가 쉘 heredoc 을 여러 겹 통과하면서 소실되기 쉬웠다.
--
-- __INTERNAL_KEY__ 는 user-patches.sh 가 기동 시 치환한다.

local url = "http://backend:8000/api/internal/mail-auth"
local key = "__INTERNAL_KEY__"

local client

function script_init()
  -- 설정 이름이 틀리면 script_init 이 실패하고 dovecot 의 auth 프로세스 전체가
  -- 종료된다(= 모든 메일 로그인 불가). 2.4 의 lua http 클라이언트는 timeout /
  -- max_attempts 를 미지원한다(둘 다 'unknown setting' 으로 종료됨). 기본값을 사용한다.
  client = dovecot.http.client({})
  return 0
end

function script_deinit()
end

local function enc(v)
  return (v:gsub("[^%w%-%._~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

function auth_passdb_lookup(req)
  -- 평문 메커니즘(PLAIN/LOGIN)에서만 비밀번호가 전달된다. 그 외의 경우는
  -- 판단하지 않고 다음 passdb 로 전달한다.
  if req.password == nil or req.password == "" then
    return dovecot.auth.PASSDB_RESULT_NEXT, nil
  end

  local body = "email=" .. enc(req.user) .. "&password=" .. enc(req.password)

  local ok, res = pcall(function()
    local hreq = client:request({ url = url, method = "POST" })
    hreq:add_header("Content-Type", "application/x-www-form-urlencoded")
    hreq:add_header("X-Internal-Key", key)
    hreq:set_payload(body)
    return hreq:submit()
  end)

  -- 백엔드 부재 또는 응답 지연 시 로그인을 차단하지 않는다. 다음 passdb 가 처리한다.
  if not ok or res == nil then
    return dovecot.auth.PASSDB_RESULT_NEXT, nil
  end

  if res:status() == 200 then
    -- 2.4 는 두 번째 반환값으로 nil 또는 **테이블**만 허용한다(문자열이면
  -- "invalid return value (expected nil or table, got string)").
  return dovecot.auth.PASSDB_RESULT_OK, { nopassword = "y" }
  end

  return dovecot.auth.PASSDB_RESULT_NEXT, nil
end
