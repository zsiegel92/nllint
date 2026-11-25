import os
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web" / "dist"
API_ONLY = os.getenv("NLLINT_MODAL_API_ONLY") == "1"
if not API_ONLY and not (WEB / "index.html").is_file():
    raise RuntimeError(
        "Build the control plane with npm --prefix web ci && npm --prefix web run build"
    )

app = modal.App("nllint-gateway")
image = (
    modal.Image.debian_slim(python_version="3.13")
    .uv_sync(uv_project_dir=str(ROOT), extra_options="--no-dev")
    .env({"NLLINT_WEB_DIR": "/opt/nllint/web"})
    .add_local_python_source("nllint_gateway")
    .add_local_file(
        ROOT / "nllint_gateway" / "schema.sql", "/root/nllint_gateway/schema.sql"
    )
)

if not API_ONLY:
    image = image.add_local_dir(WEB, "/opt/nllint/web")


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name(os.getenv("NLLINT_MODAL_SECRET", "nllint-gateway"))
    ],
    min_containers=1,
    max_containers=4,
)
@modal.concurrent(max_inputs=12)
@modal.asgi_app(label="nllint-gateway")
def gateway():
    from nllint_gateway.main import app as asgi_app

    return asgi_app
