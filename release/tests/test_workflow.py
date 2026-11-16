"""빌드 워크플로가 compose 의 build 설정과 동일한 대상을 빌드하는지, 서명·비공개 키가 포함되지 않았는지 검증."""

import re

import pytest

from jwrelease import compose

from conftest import REPO_ROOT

yaml = pytest.importorskip("yaml")

WORKFLOW = REPO_ROOT / ".github" / "workflows" / "build-images.yml"


@pytest.fixture(scope="module")
def workflow():
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def matrix(workflow):
    return {item["name"]: item for item in workflow["jobs"]["build"]["strategy"]["matrix"]["include"]}


def test_matrix_covers_every_compose_build(matrix, compose_text):
    own = compose.own_images(compose.read_images(compose_text, {}))
    assert {i.service for i in own} == set(matrix) - {"installer"}
    for image in own:
        item = matrix[image.service]
        assert item["context"] == image.build.context, image.service
        assert item["dockerfile"] == image.build.dockerfile_path, image.service
        assert item.get("target") == image.build.target, image.service
        assert not item.get("optional"), image.service
        assert (REPO_ROOT / item["dockerfile"]).is_file()


def test_installer_builds_from_repo_root(matrix):
    """설치 관리자 이미지는 리포 루트를 빌드 컨텍스트로 빌드한다(Dockerfile 머리말·docs/installer.md 의 명령과 동일)."""
    item = matrix["installer"]
    assert item["context"] == "." and item["dockerfile"] == "installer/Dockerfile"
    assert not item.get("optional")
    assert (REPO_ROOT / item["dockerfile"]).is_file()
    assert (REPO_ROOT / (item["dockerfile"] + ".dockerignore")).is_file()      # 빌드 컨텍스트 축소용 목록
    assert item["build_args_registry"] == "JW_REGISTRY"                        # pull 대상 이미지 저장소를 빌드 시 내장한다
    dockerfile = (REPO_ROOT / item["dockerfile"]).read_text(encoding="utf-8")
    assert re.search(r"^ARG JW_REGISTRY=", dockerfile, re.MULTILINE)


def test_triggers(workflow):
    on = workflow.get("on", workflow.get(True))            # YAML 1.1 은 `on` 을 불리언으로 해석한다
    assert on["push"] == {"tags": ["v*-beta.*"]}            # Stable 은 재빌드하지 않는다(승격만 수행)
    assert on["workflow_dispatch"]["inputs"]["version"]["required"] is True
    assert "branches" not in on["push"] and "pull_request" not in on


def test_amd64_only_with_gha_cache_and_digest_output(workflow):
    steps = workflow["jobs"]["build"]["steps"]
    build = next(s for s in steps if s.get("id") == "build")
    with_ = build["with"]
    assert with_["platforms"] == "linux/amd64"
    assert with_["push"] is True
    assert with_["cache-from"].startswith("type=gha") and with_["cache-to"].startswith("type=gha")
    assert with_["context"] == "${{ matrix.context }}" and with_["file"] == "${{ matrix.dockerfile }}"
    assert with_["tags"] == "${{ env.IMAGE }}:${{ env.VERSION }}"
    record = next(s for s in steps if s.get("name") == "Record digest")
    assert record["env"]["DIGEST"] == "${{ steps.build.outputs.digest }}"


def test_digests_job_collects_and_uploads(workflow):
    job = workflow["jobs"]["digests"]
    assert job["needs"] == ["version", "build"]
    uploads = [s for s in job["steps"] if "upload-artifact" in s.get("uses", "")]
    assert uploads and uploads[-1]["with"]["path"] == "digests.json"
    script = next(s for s in job["steps"] if s.get("name") == "Assemble digests.json")["run"]
    for field in ('"format": 1', '"version"', '"registry"', '"commit"', '"images"'):
        assert field in script


def test_login_uses_github_token_and_minimal_permissions(workflow):
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["jobs"]["build"]["permissions"] == {"contents": "read", "packages": "write"}
    login = next(s for s in workflow["jobs"]["build"]["steps"] if "login-action" in s.get("uses", ""))
    assert "secrets.GITHUB_TOKEN" in login["with"]["password"]


def test_no_signing_and_no_private_key_in_ci():
    text = WORKFLOW.read_text(encoding="utf-8")
    code = "\n".join(line.split("#", 1)[0] for line in text.splitlines())      # 주석 제외
    assert not re.search(r"cosign|sign-blob|PRIVATE[ _]KEY|SIGNING|jwrelease", code, re.IGNORECASE)
    secrets = set(re.findall(r"secrets\.([A-Z_]+)", code))
    assert secrets <= {"GITHUB_TOKEN", "REGISTRY_USER", "REGISTRY_TOKEN"}


def test_actions_pinned_to_commit(workflow):
    uses = [s["uses"] for job in workflow["jobs"].values() for s in job["steps"] if "uses" in s]
    assert uses
    for ref in uses:
        assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", ref), ref


def test_no_untrusted_input_interpolated_into_scripts(workflow):
    """입력값·ref 이름은 env 로만 전달한다(스크립트 본문에 직접 삽입하지 않는다)."""
    for job in workflow["jobs"].values():
        for step in job["steps"]:
            run = step.get("run", "")
            assert "${{" not in run, step.get("name")


def test_every_image_carries_the_license_notices(workflow, matrix, compose_text):
    """자체 빌드 이미지는 모두 LICENSE · NOTICE · THIRD_PARTY_LICENSES.md 를 /licenses/ 에 포함한다.

    세 파일은 리포 루트에 위치한다 — compose·워크플로·Dockerfile 이 동일한 이름의 빌드 컨텍스트(licenses)를 사용하는지 검증한다.
    """
    services = yaml.safe_load(compose_text)["services"]
    own = {name: svc["build"] for name, svc in services.items() if "build" in svc}
    assert set(own) == set(matrix) - {"installer"}
    for name, build in own.items():
        assert build.get("additional_contexts") == {"licenses": "."}, name
    step = next(s for s in workflow["jobs"]["build"]["steps"] if s.get("id") == "build")
    assert step["with"]["build-contexts"] == "licenses=."
    copy = re.compile(r"^COPY (--from=licenses )?(--chmod=\d+ )?LICENSE NOTICE THIRD_PARTY_LICENSES\.md /licenses/$", re.MULTILINE)
    for name, item in matrix.items():
        found = copy.search((REPO_ROOT / item["dockerfile"]).read_text(encoding="utf-8"))
        assert found, name
        assert bool(found.group(1)) == (item["context"] != "."), name        # 빌드 컨텍스트가 리포 루트면 직접 복사한다
    # 명명된 빌드 컨텍스트로는 고지 파일만 전달된다
    ignore = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
    assert [line for line in ignore if line and not line.startswith("#")] == ["*", "!LICENSE", "!NOTICE", "!THIRD_PARTY_LICENSES.md"]


def test_repo_license_is_agpl_and_package_metadata_agrees():
    """리포의 라이선스는 AGPL-3.0-or-later 이다 — LICENSE 는 FSF 의 문안과 동일하며, 패키지 메타데이터도 동일한 표기를 사용한다."""
    import hashlib
    import json

    text = (REPO_ROOT / "LICENSE").read_bytes()
    assert hashlib.sha256(text).hexdigest() == "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0"
    notice = (REPO_ROOT / "NOTICE").read_text(encoding="utf-8")
    assert "GNU Affero General Public License" in notice and "SPDX-License-Identifier: AGPL-3.0-or-later" in notice
    for folder in ("apps/desktop", "apps/mobile", "frontend-react", "plugins", "rbi/mirror"):
        package = json.loads((REPO_ROOT / folder / "package.json").read_text(encoding="utf-8"))
        assert package["license"] == "AGPL-3.0-or-later", folder
        lock = json.loads((REPO_ROOT / folder / "package-lock.json").read_text(encoding="utf-8"))
        assert lock["packages"][""].get("license") == "AGPL-3.0-or-later", folder


def test_source_repo_url_matches_the_backend_default():
    """제품 화면의 "소스 코드" 링크 — backend 의 기본 주소와 릴리스 도구의 값이 동일해야 한다."""
    from jwrelease.config import Settings

    text = (REPO_ROOT / "backend" / "app" / "source.py").read_text(encoding="utf-8")
    assert f'DEFAULT_SOURCE_URL = "{Settings().source_repo_url}"' in text


def test_backend_release_image_has_no_test_tools(matrix, compose_text):
    """릴리스에 포함되는 backend 이미지는 runtime 대상이며, 테스트 도구는 test 대상(requirements-dev.txt)에만 존재한다."""
    backend = REPO_ROOT / "backend"
    own = {i.service: i for i in compose.own_images(compose.read_images(compose_text, {}))}
    assert own["backend"].build.target == "runtime" and matrix["backend"]["target"] == "runtime"

    stages = re.findall(r"^FROM\s+(\S+)\s+AS\s+(\S+)\s*$", (backend / "Dockerfile").read_text(encoding="utf-8"), re.M)
    assert [name for _, name in stages] == ["base", "test", "runtime"]
    assert dict((name, parent) for parent, name in stages)["runtime"] == "base"     # test 스테이지를 기반으로 하지 않는다
    assert stages[-1][1] == "runtime"                                                # --target 없이 빌드해도 운영 이미지가 생성된다

    def names(path):
        lines = (ln.split("#")[0].strip() for ln in path.read_text(encoding="utf-8").splitlines())
        return {re.split(r"[=<>\[ ]", ln, maxsplit=1)[0].lower() for ln in lines if ln and not ln.startswith("-")}

    test_only = {"pytest", "pytest-asyncio", "pytest-cov", "aiosqlite"}
    assert not names(backend / "requirements.txt") & test_only
    assert test_only <= names(backend / "requirements-dev.txt")
    assert "-r requirements.txt" in (backend / "requirements-dev.txt").read_text(encoding="utf-8")
    dockerfile = (backend / "Dockerfile").read_text(encoding="utf-8")
    assert dockerfile.index("requirements-dev.txt .") > dockerfile.index("AS test")
