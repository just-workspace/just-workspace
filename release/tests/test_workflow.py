"""빌드 워크플로가 compose 의 build 설정과 같은 것을 빌드하는지, 서명·비공개 키가 끼어들지 않았는지."""

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
    """설치 관리자 이미지는 리포 루트를 문맥으로 빌드한다(Dockerfile 머리말·docs/installer.md 의 명령과 같다)."""
    item = matrix["installer"]
    assert item["context"] == "." and item["dockerfile"] == "installer/Dockerfile"
    assert not item.get("optional")
    assert (REPO_ROOT / item["dockerfile"]).is_file()
    assert (REPO_ROOT / (item["dockerfile"] + ".dockerignore")).is_file()      # 문맥을 줄이는 목록
    assert item["build_args_registry"] == "JW_REGISTRY"                        # 받을 이미지 저장소를 굽는다
    dockerfile = (REPO_ROOT / item["dockerfile"]).read_text(encoding="utf-8")
    assert re.search(r"^ARG JW_REGISTRY=", dockerfile, re.MULTILINE)


def test_triggers(workflow):
    on = workflow.get("on", workflow.get(True))            # YAML 1.1 은 `on` 을 불리언으로 읽는다
    assert on["push"] == {"tags": ["v*-beta.*"]}            # Stable 은 다시 빌드하지 않는다(승격만)
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
    """입력값·ref 이름은 env 로만 넘긴다(스크립트 본문에 직접 끼우지 않는다)."""
    for job in workflow["jobs"].values():
        for step in job["steps"]:
            run = step.get("run", "")
            assert "${{" not in run, step.get("name")
