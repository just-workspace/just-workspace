"""docker-mailserver account management.

Manages accounts by executing `setup email` commands inside the ws-mailserver container.
Requires the backend to have access to the Docker socket or use docker exec via subprocess.
"""

import asyncio
import logging
import re
import subprocess

from app.config import get_settings

_EMAIL_RE = re.compile(r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$')

logger = logging.getLogger(__name__)
settings = get_settings()

CONTAINER_NAME = "ws-mailserver"


def _docker_exec(
    args: list[str],
    stdin_data: str | None = None,
    secrets: tuple[str, ...] = (),
) -> tuple[int, str]:
    """Run a command inside the mailserver container (blocking).

    stdin_data 를 주면 `docker exec -i` 로 표준입력에 흘려보낸다. 비밀번호를
    명령행 인자로 넘기면 컨테이너의 프로세스 목록(ps)에 평문으로 노출되므로,
    `setup email add/update` 의 선택 인자 <PASSWORD> 를 생략하고 프롬프트에
    stdin 으로 답한다.

    secrets 에 준 문자열은 반환되는 출력에서 마스킹한다 — 명령이 실패할 때
    사용법(usage)에 인자가 섞여 나오면 그대로 로그에 남기 때문이다.
    """
    full_cmd = ["docker", "exec"]
    if stdin_data is not None:
        full_cmd.append("-i")
    full_cmd += [CONTAINER_NAME] + args
    try:
        result = subprocess.run(
            full_cmd, input=stdin_data, capture_output=True, text=True, timeout=15,
        )
        out = (result.stdout.strip() + result.stderr.strip())
    except subprocess.TimeoutExpired:
        return 1, "timeout"
    except Exception as e:
        out, result = str(e), None
    for sec in secrets:
        if sec:
            out = out.replace(sec, "***")
    return (result.returncode if result is not None else 1), out


def _password_stdin(password: str) -> str:
    """비밀번호 프롬프트는 입력·확인 두 번 묻는다."""
    return password + chr(10) + password + chr(10)


async def create_account(email: str, password: str) -> bool:
    """Create a mail account in docker-mailserver. Returns True on success."""
    if not _EMAIL_RE.match(email):
        logger.error("Invalid email format rejected: %s", email)
        return False
    rc, out = await asyncio.to_thread(
        _docker_exec,
        ["setup", "email", "add", email],
        _password_stdin(password),
        (password,),
    )
    if rc == 0:
        logger.info("Mail account created: %s", email)
        return True
    # Already exists is OK
    if "already exists" in out.lower():
        logger.info("Mail account already exists: %s", email)
        return True
    logger.error("Failed to create mail account %s: %s", email, out)
    return False


async def delete_account(email: str) -> bool:
    """Delete a mail account from docker-mailserver.

    `-y` 는 "메일함 데이터까지 지운다" 는 뜻인데, docker-mailserver v16 의
    delmailuser 는 그 디렉터리가 없으면 지우지 못하고 **중단한다**. 메일함은
    첫 수신 때 생기므로, 만들어 두고 한 통도 받지 않은 계정은 이 경로로 못 지운다
    (워크스페이스 계정을 만들었다 지우면 정확히 그 상황이다).

    지울 메일함이 없을 때는 `-n`("메일함은 남긴다") 이 같은 일을 해 준다 —
    남길 것이 애초에 없으므로. 그래서 그때만 한 번 더 시도한다.
    """
    rc, out = await asyncio.to_thread(
        _docker_exec,
        ["setup", "email", "del", "-y", email],
    )
    if rc != 0 and "does not exist" in out.lower():
        logger.info("Mailbox data directory absent, retrying without it: %s", email)
        rc, out = await asyncio.to_thread(
            _docker_exec,
            ["setup", "email", "del", "-n", email],
        )
    if rc == 0:
        logger.info("Mail account deleted: %s", email)
        return True
    if "not found" in out.lower():
        logger.info("Mail account not found (already deleted): %s", email)
        return True
    logger.error("Failed to delete mail account %s: %s", email, out)
    return False


async def update_password(email: str, new_password: str) -> bool:
    """Update a mail account password in docker-mailserver."""
    if not _EMAIL_RE.match(email):
        logger.error("Invalid email format rejected: %s", email)
        return False
    rc, out = await asyncio.to_thread(
        _docker_exec,
        ["setup", "email", "update", email],
        _password_stdin(new_password),
        (new_password,),
    )
    if rc == 0:
        logger.info("Mail password updated: %s", email)
        return True
    logger.error("Failed to update mail password %s: %s", email, out)
    return False


async def account_exists(email: str) -> bool:
    """Check if a mail account exists."""
    rc, out = await asyncio.to_thread(
        _docker_exec,
        ["setup", "email", "list"],
    )
    if rc != 0:
        return False
    return email in out
