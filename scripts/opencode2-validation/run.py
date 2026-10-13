#!/usr/bin/env python3
"""Validate OpenCode 2 behind an isolated opshelper gateway."""
import argparse
import json
import os
import pathlib
import secrets
import subprocess
import time
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--keep", action="store_true", help="Keep only this isolated stack for debugging")
args = parser.parse_args()
root = REPO / ".temp" / ("opencode2-validation-" + secrets.token_hex(4))
root.mkdir(parents=True)
data = root / "data"
data.mkdir()
project = root.name
env = {**os.environ, "COMPOSE_PROJECT_NAME": project, "UPGRADE_REPO": str(REPO),
       "UPGRADE_DATA": str(data), "UPGRADE_PRIVATE_DIR": str(root),
       "UPGRADE_TEST_PASSWORD": secrets.token_hex(16), "UPGRADE_TEST_PORT": "4340",
       "UPGRADE_POSTGRES_CONTAINER": project + "-postgres-1"}
environment_file = root / "environment.json"
environment_file.write_text(json.dumps({k: v for k, v in env.items() if k.startswith("UPGRADE_") or k == "COMPOSE_PROJECT_NAME"}))
environment_file.chmod(0o600)
compose = ["docker", "compose", "-f", str(REPO / "scripts/opencode2-validation/compose.yml"), "-p", project]

def run(command, **kwargs):
    result = subprocess.run(command, cwd=REPO, env=env, text=True, capture_output=True, timeout=1200, **kwargs)
    if result.returncode:
        # Full diagnostics remain private; avoid printing credential-bearing config.
        (root / "command-error.log").write_text(result.stdout + result.stderr)
        raise RuntimeError(f"Command failed: {command[0]} {command[1:3]}; see {root}/command-error.log")
    return result.stdout

def health():
    end = time.monotonic() + 120
    while time.monotonic() < end:
        try:
            if urllib.request.urlopen("http://127.0.0.1:4340/health", timeout=2).status == 200:
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError("Isolated gateway failed to become healthy")

print(f"Isolated test directory: {root}", flush=True)
try:
    env["UPGRADE_API_IMAGE"] = "opshelper/opencode2-api:validation"
    env["UPGRADE_RUNTIME_IMAGE"] = "opshelper/opencode-runtime:2.0.27"
    run(compose + ["up", "-d", "postgres", "fixture"])
    run(compose + ["run", "--rm", "api", "npx", "prisma", "migrate", "deploy"])
    run(compose + ["run", "--rm", "api", "npx", "tsx", "prisma/seed.ts"])
    run(compose + ["up", "-d", "api", "worker", "web", "nginx"])
    health()
    print(run(["node", "scripts/opencode2-validation/acceptance.mjs"]), flush=True)

finally:
    if not args.keep:
        fixture = root / "fixture.json"
        if fixture.exists():
            for uid in json.loads(fixture.read_text()).get("users", {}).values():
                name = "opshelper-user-" + uid
                result = subprocess.run(["docker", "inspect", name], capture_output=True, text=True)
                if not result.returncode:
                    mounts = json.loads(result.stdout)[0]["Mounts"]
                    if not any(pathlib.Path(m["Source"]).resolve().is_relative_to(data.resolve()) for m in mounts):
                        raise RuntimeError("Refusing to remove a runtime outside this isolated test directory")
                    run(["docker", "rm", "-f", name])
        run(compose + ["down", "-v", "--remove-orphans"])
        print("Isolated containers and database volume removed; reports retained", flush=True)
