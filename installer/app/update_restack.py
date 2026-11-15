"""스택 파일을 이 이미지의 번들로 다시 쓴다 — `python -m app.update_restack`.

업데이트의 `switch` 단계가 **새 버전의 설치 관리자 이미지**로 일회용 컨테이너를 띄워 이 명령을 돌린다. 그래서
compose·nginx 템플릿·구역 선언(번들)과 그것을 `.env`·설정 파일로 바꾸는 코드가 모두 새 버전의 것이다.
답변·비밀값·감지값은 상태 폴더의 것을 그대로 쓴다(새로 만들지 않는다). 컨테이너는 건드리지 않는다.

    docker run --rm -v <설치 폴더>:/data -e JW_HOST_DIR=<설치 폴더> -e JW_REGISTRY=… -e JW_IMAGE_TAG=<버전> \
        --entrypoint python <새 설치 관리자 이미지> -m app.update_restack
"""

from __future__ import annotations

import json
import os
import sys

from app import dkim, render
from app import paths as paths_mod
from app.bundle import Bundle
from app.catalog import Catalog
from app.state import Store, write_private


def restack(paths: paths_mod.Paths, registry: str, image_tag: str | None) -> dict:
    bundle = Bundle(paths.bundle)
    catalog = Catalog(bundle.zones)
    store = Store(paths)
    answers, facts = store.load_answers(), store.facts()
    secrets = dict(store.env_secrets())
    plan = render.derive(answers, facts, catalog)
    if plan.mail_builtin:
        secrets["DKIM_PRIVATE_KEY"] = dkim.ensure(store, plan.mail_domain)["private_key"]
    files = render.render(answers, secrets, facts, bundle, registry=registry, image_tag=image_tag or bundle.version)
    for rel_path, content in files.items():
        target = paths.stack / rel_path
        if rel_path in render.MERGE_FILES and target.exists():
            content = render.merge_lines(target.read_text(encoding="utf-8"), content)
        write_private(target, content, render.file_mode(rel_path))
    return {"version": bundle.version, "files": len(files), "zones": plan.zones}


def main() -> int:
    paths = paths_mod.from_env()
    if not (paths.state / "install.json").exists():
        print("설치된 서버가 아닙니다", file=sys.stderr)
        return 1
    registry = os.environ.get("JW_REGISTRY") or "localhost"
    print(json.dumps(restack(paths, registry, os.environ.get("JW_IMAGE_TAG") or None), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
