#!/usr/bin/env python3
"""Exercise real old/new OpenCode images behind an isolated opshelper gateway."""
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
parser.add_argument("--baseline-ref", default="HEAD", help="Application ref used with OpenCode 1.17.9 to create baseline snapshots")
args = parser.parse_args()
root = REPO / ".temp" / ("opencode-upgrade-" + secrets.token_hex(4))
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
compose = ["docker", "compose", "-f", str(REPO / "scripts/runtime-upgrade/compose.yml"), "-p", project]

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
    source = root / "baseline-source"
    source.mkdir()
    archive = root / "baseline-source.tar"
    run(["git", "archive", "--output", str(archive), args.baseline_ref])
    run(["tar", "-xf", str(archive), "-C", str(source)])
    run(["docker", "build", "--target", "api", "-t", "opshelper/opencode-upgrade-baseline-api:validation", str(source)])
    env["UPGRADE_API_IMAGE"] = "opshelper/opencode-upgrade-baseline-api:validation"
    env["UPGRADE_RUNTIME_IMAGE"] = "opshelper/opencode-runtime:1.17.9"
    run(compose + ["up", "-d", "postgres", "fixture"])
    run(compose + ["run", "--rm", "api", "npx", "prisma", "migrate", "deploy"])
    run(compose + ["run", "--rm", "api", "npx", "tsx", "prisma/seed.ts"])
    run(compose + ["up", "-d", "api", "web", "nginx"])
    health()
    print(run(["node", "scripts/runtime-upgrade/acceptance.mjs", "baseline"]), flush=True)
    # Reproduce older production layout without putting the private agent in
    # another user's catalog. The old runtime has already persisted its snapshot.
    owner = json.loads((root / "fixture.json").read_text())["users"]["upgrade-alice"]
    private_parent = data / "users" / owner / "agents"
    private_parent.mkdir()
    (data / "agents" / "personal-upgrade").rename(private_parent / "personal-upgrade")
    env["UPGRADE_RUNTIME_IMAGE"] = "opshelper/opencode-runtime:1.18.34"
    env["UPGRADE_API_IMAGE"] = "opshelper/opencode-upgrade-api:validation"
    run(compose + ["up", "-d", "--force-recreate", "api", "worker"])
    health()
    print(run(["node", "scripts/runtime-upgrade/acceptance.mjs", "upgrade"]), flush=True)
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
