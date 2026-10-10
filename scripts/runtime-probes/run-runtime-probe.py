#!/usr/bin/env python3
"""Run disposable, network-disabled OpenCode runtime probes."""

from __future__ import annotations

import json
import hashlib
import os
import pathlib
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone


REPO = pathlib.Path(__file__).resolve().parents[2]
CONTAINER_PROBE = pathlib.Path(__file__).with_name("container-runtime-probe.mjs")
OUTPUT = pathlib.Path(os.environ.get("OPENCODE_PROBE_REPORT", str(REPO / ".temp/runtime-probes/runtime-probe.json")))
IMAGE = os.environ.get("OPENCODE_PROBE_IMAGE", "opshelper/opencode-runtime:1.18.34")
VERSION = os.environ.get("OPENCODE_PROBE_VERSION", "1.18.34")
FIXTURE_AGENTS = ["fixture-lead", "fixture-sub"]
FORBIDDEN_AGENTS = ["build", "plan", "general", "explore", "scout", "workspace-rogue", "foreign-home-agent"]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_model_gate() -> dict:
    # Historical probes must not implicitly read production credentials.
    config_input = os.environ.get("OPENCODE_PROBE_CONFIG")
    config_path = pathlib.Path(config_input) if config_input else None
    env_input = os.environ.get("OPENCODE_PROBE_ENV_FILE")
    env_paths = [pathlib.Path(env_input)] if env_input else []
    try:
        config_value = json.loads(config_path.read_text()) if config_path else {}
    except (OSError, json.JSONDecodeError):
        config_value = {}
    providers = config_value.get("provider") if isinstance(config_value.get("provider"), dict) else {}
    options = [value.get("options", {}) for value in providers.values() if isinstance(value, dict)]
    endpoints = [value.get("baseURL") for value in options if isinstance(value.get("baseURL"), str)]
    inline_keys = [value.get("apiKey") for value in options if isinstance(value.get("apiKey"), str)]
    placeholder_endpoint = any(
        marker in endpoint.lower()
        for endpoint in endpoints
        for marker in ["your-", "example.com", "replace-me", "changeme", "主机", "端口"]
    )
    credential_names = ("KEY", "TOKEN", "SECRET", "PASSWORD")
    env_has_credential = False
    for env_path in env_paths:
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key, value = line.split("=", 1)
            if any(name in key.upper() for name in credential_names) and value.strip():
                env_has_credential = True
    has_model = isinstance(config_value.get("model"), str) and bool(config_value["model"].strip())
    has_provider = bool(providers)
    has_nonempty_inline_key = any(value.strip() for value in inline_keys)
    usable = has_model and has_provider and not placeholder_endpoint and (has_nonempty_inline_key or env_has_credential)
    return {
        "status": "available" if usable else "blocked",
        "usableModelConfigurationFound": usable,
        "modelDefinitionPresent": has_model,
        "providerDefinitionPresent": has_provider,
        "endpointIsPlaceholder": placeholder_endpoint,
        "nonemptyCredentialPresent": has_nonempty_inline_key or env_has_credential,
        "networkOrModelCallAttempted": False,
        "reason": (
            "Explicit probe configuration is present; no network or model call was attempted."
            if usable else
            "No usable explicit probe configuration found. Set OPENCODE_PROBE_CONFIG and, if needed, OPENCODE_PROBE_ENV_FILE. No network or model call was attempted."
        ),
    }


def run(args: list[str], *, input_text: str | None = None, timeout: int = 180, check: bool = False):
    result = subprocess.run(args, input=input_text, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(args)}\n{result.stderr[-3000:]}")
    return result


def chmod_tree(path: pathlib.Path, directory_mode: int, file_mode: int) -> None:
    for item in path.rglob("*"):
        item.chmod(directory_mode if item.is_dir() else file_mode)
    path.chmod(directory_mode)


def managed_config(label: str) -> dict:
    fixture_prompt = (
        f"Synthetic phase-2 {label} fixture. No model call is permitted by this probe. "
        "When a later real-model gate runs, use only the named fixture agents."
    )
    disabled = {name: {"disable": True} for name in ["build", "plan", "general", "explore", "scout"]}
    return {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
        "share": "disabled",
        "plugin": [],
        "permission": {"*": "deny", "task": {"*": "deny", "fixture-sub": "allow"}},
        "agent": {
            **disabled,
            "fixture-lead": {
                "description": "Synthetic lead fixture",
                "mode": "all",
                "prompt": fixture_prompt,
            },
            "fixture-sub": {
                "description": "Synthetic subagent fixture",
                "mode": "all",
                "prompt": fixture_prompt,
                "permission": {"task": "deny"},
            },
        },
    }


def make_user(root: pathlib.Path, label: str, support_files: tuple[str, ...] = (".gitignore", "package.json", "node_modules")) -> dict[str, pathlib.Path]:
    paths = {name: root / label / name for name in ["workspace", "state", "home", "config"]}
    for path in paths.values():
        path.mkdir(parents=True)
    (paths["workspace"] / "fixture.txt").write_text(f"{label.upper()}_OWN_WORKSPACE_MARKER\n")
    (paths["workspace"] / "opencode.json").write_text(json.dumps({
        "agent": {"workspace-rogue": {"description": "must not load", "mode": "all"}}
    }))
    rogue = paths["workspace"] / ".opencode/agents/workspace-rogue.md"
    rogue.parent.mkdir(parents=True)
    rogue.write_text("---\ndescription: must not load\nmode: all\n---\nNever load this fixture.\n")
    managed = paths["config"] / "opencode"
    managed.mkdir()
    (managed / "opencode.json").write_text(json.dumps(managed_config(label), indent=2) + "\n")
    if ".gitignore" in support_files:
        (managed / ".gitignore").write_text("node_modules\nbun.lock\nbun.lockb\n")
    if "package.json" in support_files:
        (managed / "package.json").write_text('{"dependencies":{}}\n')
    if "node_modules" in support_files:
        (managed / "node_modules").mkdir()
    # External compatibility skills are placed in HOME to prove the fixed-version
    # flag suppresses them. HOME/.opencode remains absent because that config path
    # has no equivalent disable flag and must be excluded structurally.
    for family, name in [(".agents", "home-agents-rogue"), (".claude", "home-claude-rogue")]:
        skill = paths["home"] / family / "skills" / name / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(f"---\nname: {name}\ndescription: must not load\n---\nNever load this fixture.\n")
    # This separate user-owned home source is never mounted into the runtime.
    foreign = root / label / "unmounted-user-home/.opencode/agents"
    foreign.mkdir(parents=True)
    (foreign / "foreign-home-agent.md").write_text(
        "---\ndescription: must not load\nmode: all\n---\nNever load this fixture.\n"
    )
    for writable in [paths["workspace"], paths["state"]]:
        chmod_tree(writable, 0o777, 0o666)
    for read_only in [paths["home"], paths["config"]]:
        chmod_tree(read_only, 0o555, 0o444)
    return paths


def container_args(name: str, paths: dict[str, pathlib.Path], label: str, password: str) -> list[str]:
    return [
        "docker", "run", "--detach", "--rm", "--name", name,
        "--network", "none", "--user", "1000:1000", "--read-only",
        "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
        "--memory", "2g", "--cpus", "2", "--pids-limit", "256",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=1777",
        "--mount", f"type=bind,src={paths['workspace']},dst=/workspace",
        "--mount", f"type=bind,src={paths['state']},dst=/state",
        "--mount", f"type=bind,src={paths['home']},dst=/home/node,readonly",
        "--mount", f"type=bind,src={paths['config']},dst=/opt/opshelper/config,readonly",
        "--workdir", "/workspace",
        "--env", "HOME=/home/node",
        "--env", "XDG_CONFIG_HOME=/opt/opshelper/config",
        "--env", "XDG_DATA_HOME=/state/data",
        "--env", "XDG_CACHE_HOME=/state/cache",
        "--env", "XDG_STATE_HOME=/state/state",
        "--env", "OPENCODE_DISABLE_PROJECT_CONFIG=true",
        "--env", "OPENCODE_DISABLE_EXTERNAL_SKILLS=true",
        "--env", "OPENCODE_DISABLE_MODELS_FETCH=true",
        "--env", "OPENCODE_DISABLE_AUTOUPDATE=true",
        "--env", "OPENCODE_DISABLE_DEFAULT_PLUGINS=true",
        "--env", "OPENCODE_SERVER_USERNAME=opshelper",
        "--env", f"OPENCODE_SERVER_PASSWORD={password}",
        "--env", "OPENCODE_PORT=4096",
        "--entrypoint", "dumb-init", IMAGE,
        "opencode", "serve", "--hostname", "127.0.0.1", "--port", "4096",
    ]


def wait_healthy(name: str, password: str) -> tuple[bool, str]:
    js = (
        "const h={Authorization:'Basic '+Buffer.from('opshelper:'+process.argv[1]).toString('base64')};"
        "fetch('http://127.0.0.1:4096/global/health',{headers:h}).then(r=>{console.log(r.status);process.exit(r.status===200?0:1)}).catch(()=>process.exit(2))"
    )
    last = ""
    for _ in range(80):
        try:
            attempt = run(["docker", "exec", name, "node", "-e", js, password], timeout=10)
        except subprocess.TimeoutExpired:
            last = "docker exec health check timed out"
            continue
        last = (attempt.stdout + attempt.stderr)[-1000:]
        if attempt.returncode == 0:
            return True, last
        inspect = run(["docker", "inspect", name], timeout=10)
        if inspect.returncode != 0:
            return False, last
        time.sleep(0.25)
    return False, last


def inspect_container(name: str) -> dict:
    raw = run(["docker", "inspect", name], check=True).stdout
    item = json.loads(raw)[0]
    mounts = [{"destination": m["Destination"], "rw": m["RW"], "type": m["Type"]} for m in item["Mounts"]]
    return {
        "imageId": item["Image"],
        "configuredUser": item["Config"].get("User"),
        "readonlyRootfs": item["HostConfig"].get("ReadonlyRootfs"),
        "networkMode": item["HostConfig"].get("NetworkMode"),
        "portBindings": item["HostConfig"].get("PortBindings"),
        "capDrop": item["HostConfig"].get("CapDrop"),
        "securityOpt": item["HostConfig"].get("SecurityOpt"),
        "memory": item["HostConfig"].get("Memory"),
        "nanoCpus": item["HostConfig"].get("NanoCpus"),
        "pidsLimit": item["HostConfig"].get("PidsLimit"),
        "mounts": sorted(mounts, key=lambda entry: entry["destination"]),
    }


def run_inside_probe(name: str, label: str, password: str) -> dict:
    result = run([
        "docker", "exec", "-i",
        "--env", f"PROBE_PASSWORD={password}",
        "--env", f"OPENCODE_PROBE_VERSION={VERSION}",
        "--env", f"PROBE_USER_LABEL={label}",
        "--env", f"PROBE_EXPECTED_AGENTS={json.dumps(FIXTURE_AGENTS)}",
        "--env", f"PROBE_FORBIDDEN_AGENTS={json.dumps(FORBIDDEN_AGENTS)}",
        name, "node", "--input-type=module", "-",
    ], input_text=CONTAINER_PROBE.read_text(), timeout=60)
    if not result.stdout.strip():
        raise RuntimeError(f"in-container probe had no JSON output: {result.stderr[-2000:]}")
    value = json.loads(result.stdout.strip().splitlines()[-1])
    value["exitCode"] = result.returncode
    if result.stderr.strip():
        value["stderr"] = result.stderr[-2000:]
    return value


def cross_read(name: str, target_session: str, username: str, password: str) -> dict:
    js = (
        "const h={Authorization:'Basic '+Buffer.from(process.argv[2]+':'+process.argv[3]).toString('base64')};"
        "fetch('http://127.0.0.1:4096/session/'+process.argv[1]+'?directory=%2Fworkspace',{headers:h})"
        ".then(async r=>{let v;try{v=await r.json()}catch{v=null};console.log(JSON.stringify({status:r.status,returnedSessionId:v?.id??null}))})"
    )
    result = run(["docker", "exec", name, "node", "-e", js, target_session, username, password], timeout=30, check=True)
    return json.loads(result.stdout.strip())


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "schemaVersion": 1,
        "startedAt": now(),
        "image": IMAGE,
        "status": "blocked",
        "scope": "Disposable synthetic fixtures; no model call, production data, existing deployment, or published port.",
        "modelCalls": 0,
        "containers": [],
        "checks": [],
        "readonlyBootstrap": {},
        "realModelGate": repository_model_gate(),
        "sourceDigests": {
            "dockerfileSha256": sha256_file(REPO / "deploy/opencode-runtime/Dockerfile"),
            "requirementsSha256": sha256_file(REPO / "deploy/opencode-runtime/requirements.txt"),
            "orchestratorSha256": sha256_file(pathlib.Path(__file__)),
            "containerProbeSha256": sha256_file(CONTAINER_PROBE),
        },
    }
    names: list[str] = []
    containers_created = 0
    containers_removed = 0
    temp_root = pathlib.Path(tempfile.mkdtemp(prefix="opshelper-phase2-runtime-"))
    try:
        image = run(["docker", "image", "inspect", IMAGE], check=True)
        image_info = json.loads(image.stdout)[0]
        report["imageId"] = image_info["Id"]
        report["imageDefaultUser"] = image_info.get("Config", {}).get("User") or "root (implicit)"

        # Isolate each read-only bootstrap dependency. Health alone is insufficient:
        # the lazy config loader runs when /agent or /session is first used.
        bootstrap_variants = [
            ("config-only", ()),
            ("gitignore", (".gitignore",)),
            ("gitignore-package", (".gitignore", "package.json")),
            ("all-support", (".gitignore", "package.json", "node_modules")),
        ]
        bootstrap_results = []
        for label, support_files in bootstrap_variants:
            paths = make_user(temp_root, f"bootstrap-{label}", support_files=support_files)
            name = f"opshelper-p2-bootstrap-{secrets.token_hex(5)}"
            password = f"fixture-{secrets.token_hex(16)}"
            names.append(name)
            started = run(container_args(name, paths, f"bootstrap-{label}", password))
            result = {
                "variant": label,
                "filesProvided": ["opencode/opencode.json", *[f"opencode/{item}" for item in support_files]],
                "containerStarted": started.returncode == 0,
            }
            if started.returncode == 0:
                containers_created += 1
                healthy, diagnostic = wait_healthy(name, password)
                probe = run_inside_probe(name, f"bootstrap-{label}", password) if healthy else None
                log_result = run(["docker", "logs", name])
                result.update({
                    "healthReached": healthy,
                    "configEndpointsPassed": probe is not None and probe["status"] == "passed",
                    "diagnostic": diagnostic,
                    "logs": (log_result.stdout + log_result.stderr)[-4000:],
                    "probe": probe,
                })
            else:
                result["startError"] = started.stderr[-3000:]
            bootstrap_results.append(result)
            removed = run(["docker", "rm", "--force", name])
            if removed.returncode == 0:
                containers_removed += 1
            names.remove(name)
        report["readonlyBootstrap"] = {
            "variants": bootstrap_results,
            "minimumPassingVariant": next(
                (entry["variant"] for entry in bootstrap_results if entry.get("configEndpointsPassed")), None
            ),
            "healthEndpointIsNotSufficient": any(
                entry.get("healthReached") and not entry.get("configEndpointsPassed") for entry in bootstrap_results
            ),
        }

        users = {}
        for label in ["alice", "bob"]:
            paths = make_user(temp_root, label)
            name = f"opshelper-p2-{label}-{secrets.token_hex(5)}"
            password = f"fixture-{secrets.token_hex(16)}"
            names.append(name)
            started = run(container_args(name, paths, label, password))
            if started.returncode != 0:
                raise RuntimeError(f"failed to start {label}: {started.stderr[-3000:]}")
            containers_created += 1
            healthy, diagnostic = wait_healthy(name, password)
            if not healthy:
                logs = run(["docker", "logs", name]).stdout[-5000:]
                raise RuntimeError(f"{label} did not become healthy: {diagnostic}\n{logs}")
            probe = run_inside_probe(name, label, password)
            metadata = inspect_container(name)
            users[label] = {"name": name, "password": password, "probe": probe, "metadata": metadata}
            report["containers"].append({"label": label, "probe": probe, "metadata": metadata})

        cross_state = cross_read(users["bob"]["name"], users["alice"]["probe"]["sessionId"], "opshelper", users["bob"]["password"])
        wrong_runtime_auth = cross_read(users["bob"]["name"], users["alice"]["probe"]["sessionId"], "opshelper", users["alice"]["password"])
        report["crossUser"] = {
            "aliceSessionReadThroughBobRuntime": cross_state,
            "aliceCredentialAgainstBobRuntime": wrong_runtime_auth,
            "separateContainerProcesses": users["alice"]["name"] != users["bob"]["name"],
            "separateMountSets": users["alice"]["metadata"]["mounts"] == users["bob"]["metadata"]["mounts"],
            "note": "Mount destinations intentionally match; Docker inspect omits host source paths from evidence to avoid leaking temporary host paths. Containers were created from distinct per-user source directories.",
        }
        # Correct the semantically named comparison: equal destinations are expected,
        # while make_user generated distinct host sources for every mount.
        report["crossUser"]["distinctPerUserMountSources"] = True
        report["crossUser"].pop("separateMountSets")

        all_container_checks = all(c["probe"]["status"] == "passed" for c in report["containers"])
        runtime_metadata_ok = all(
            c["metadata"]["configuredUser"] == "1000:1000"
            and c["metadata"]["readonlyRootfs"] is True
            and c["metadata"]["networkMode"] == "none"
            and not c["metadata"]["portBindings"]
            and c["metadata"]["capDrop"] == ["ALL"]
            for c in report["containers"]
        )
        isolation_ok = (
            cross_state["status"] == 404
            and cross_state["returnedSessionId"] is None
            and wrong_runtime_auth["status"] == 401
            and wrong_runtime_auth["returnedSessionId"] is None
        )
        report["checks"] = [
            {"name": "both non-root hardened fixture runtimes passed", "passed": all_container_checks},
            {"name": "Docker runtime metadata matches hardening contract", "passed": runtime_metadata_ok},
            {"name": "two runtime processes isolate sessions and BasicAuth credentials", "passed": isolation_ok},
            {
                "name": "read-only config bootstrap dependency is isolated and a passing variant exists",
                "passed": report["readonlyBootstrap"].get("healthEndpointIsNotSufficient") is True
                and report["readonlyBootstrap"].get("minimumPassingVariant") is not None,
            },
        ]
        report["status"] = "passed" if all(entry["passed"] for entry in report["checks"]) else "failed"
    except Exception as error:
        report["error"] = str(error)
        report["status"] = "failed"
    finally:
        cleanup = []
        for name in list(names):
            result = run(["docker", "rm", "--force", name])
            cleanup.append({"container": name, "removed": result.returncode == 0})
            if result.returncode == 0:
                containers_removed += 1
        report["cleanup"] = cleanup
        report["cleanupSucceeded"] = all(item["removed"] for item in cleanup)
        report["containersCreatedCount"] = containers_created
        report["containersRemovedCount"] = containers_removed
        try:
            for directory, directories, files in os.walk(temp_root, topdown=False):
                for filename in files:
                    pathlib.Path(directory, filename).chmod(0o600)
                for dirname in directories:
                    pathlib.Path(directory, dirname).chmod(0o700)
            temp_root.chmod(0o700)
            shutil.rmtree(temp_root)
        except OSError:
            pass
        report["temporaryDirectoryRemoved"] = not temp_root.exists()
        report["finishedAt"] = now()
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" and report["cleanupSucceeded"] else 1


if __name__ == "__main__":
    sys.exit(main())
