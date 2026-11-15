-- dovecot 이 IMAP/SMTP 로그인마다 워크스페이스 백엔드에 비밀번호를 물어본다.
--
-- 메일 비밀번호를 따로 보관하고 밀어넣어 맞추는 방식은 구조적으로 어긋난다
-- (밀어넣기 실패가 조용하고, 승인 시점에는 평문을 모른다). 그래서 한 곳만 본다.
--
-- 본문은 퍼센트 인코딩이다. JSON 을 만들려면 백슬래시 이스케이프가 필요한데
-- 그게 쉘 heredoc 여러 겹을 지나면서 소실되기 쉬웠다.
--
-- __INTERNAL_KEY__ 는 user-patches.sh 가 기동 때 치환한다.

local url = "http://backend:8000/api/internal/mail-auth"
local key = "__INTERNAL_KEY__"

local client

function script_init()
  -- 설정 이름을 틀리면 script_init 이 실패하고 dovecot 의 auth 프로세스가 통째로
  -- 죽는다(= 모든 메일 로그인 불가). 2.4 의 lua http 클라이언트는 timeout /
  -- max_attempts 를 모른다(둘 다 'unknown setting' 으로 죽었다). 기본값을 쓴다.
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
  -- 평문 메커니즘(PLAIN/LOGIN)에서만 비밀번호가 넘어온다. 그 밖의 경우는
  -- 판단하지 않고 다음 passdb 로 넘긴다.
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

  -- 백엔드가 없거나 느릴 때 로그인을 막지 않는다. 다음 passdb 가 받는다.
  if not ok or res == nil then
    return dovecot.auth.PASSDB_RESULT_NEXT, nil
  end

  if res:status() == 200 then
    -- 2.4 는 두 번째 반환값으로 nil 또는 **테이블**만 받는다(문자열이면
  -- "invalid return value (expected nil or table, got string)").
  return dovecot.auth.PASSDB_RESULT_OK, { nopassword = "y" }
  end

  return dovecot.auth.PASSDB_RESULT_NEXT, nil
end
