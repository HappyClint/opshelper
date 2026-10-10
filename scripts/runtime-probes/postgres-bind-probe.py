#!/usr/bin/env python3
"""Verify PostgreSQL persistence across container replacement on one host bind."""

from __future__ import annotations

import hashlib
import json
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
OUTPUT = REPO / ".temp/runtime-probes/postgres-bind.json"
IMAGE = "postgres:16"
PGDATA_DESTINATION = "/var/lib/postgresql/data"
DATABASE = "opshelper_fixture"
USER = "opshelper_fixture"
MARKER = "OPSHELPER_PHASE2_PG_BIND_FIXTURE"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def command(args: list[str], timeout: int = 180) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def require_ok(result: subprocess.CompletedProcess[str], context: str) -> None:
    if result.returncode != 0:
        diagnostic = (result.stdout + result.stderr)[-2000:]
        raise RuntimeError(f"{context} failed with exit code {result.returncode}: {diagnostic}")


def wait_ready(name: str) -> bool:
    for _ in range(120):
        # pg_isready can succeed against the temporary bootstrap server before
        # POSTGRES_DB has been created. Require a real query to that database.
        result = command([
            "docker", "exec", "--user", "postgres", name,
            "psql", "-X", "-At", "-U", USER, "-d", DATABASE,
            "-c", "SELECT 1;",
        ], timeout=10)
        if result.returncode == 0:
            return True
        inspect = command(["docker", "inspect", name], timeout=10)
        if inspect.returncode != 0:
            return False
        time.sleep(0.25)
    return False


def create_container(name: str, data_directory: pathlib.Path, password: str) -> None:
    result = command([
        "docker", "run", "--detach", "--name", name,
        "--network", "none",
        "--mount", f"type=bind,src={data_directory},dst={PGDATA_DESTINATION}",
        "--env", f"POSTGRES_PASSWORD={password}",
        "--env", f"POSTGRES_USER={USER}",
        "--env", f"POSTGRES_DB={DATABASE}",
        IMAGE,
    ])
    require_ok(result, "create disposable PostgreSQL container")


def inspect_container(name: str) -> dict:
    result = command(["docker", "inspect", name])
    require_ok(result, "inspect disposable PostgreSQL container")
    return json.loads(result.stdout)[0]


def query(name: str, sql: str) -> str:
    result = command([
        "docker", "exec", "--user", "postgres", name,
        "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", USER, "-d", DATABASE,
        "-c", sql,
    ])
    require_ok(result, "execute fixture SQL")
    return result.stdout.strip()


def remove_container(name: str, running: bool) -> tuple[bool, bool]:
    stopped = not running
    if running:
        stop = command(["docker", "stop", "--time", "5", name], timeout=30)
        stopped = stop.returncode == 0
    removed = command(["docker", "rm", "--force", name], timeout=30).returncode == 0
    return stopped, removed


def remove_probe_tree(root: pathlib.Path) -> bool:
    if not root.exists():
        return True
    for directory, directories, files in os.walk(root, topdown=False):
        for filename in files:
            pathlib.Path(directory, filename).chmod(0o600)
        for dirname in directories:
            pathlib.Path(directory, dirname).chmod(0o700)
    root.chmod(0o700)
    shutil.rmtree(root)
    return not root.exists()


def main() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temp_root = pathlib.Path(tempfile.mkdtemp(prefix="opshelper-phase2-postgres-bind-"))
    data_directory = temp_root / "pgdata"
    data_directory.mkdir(mode=0o777)
    suffix = secrets.token_hex(5)
    first_name = f"opshelper-p2-pg-first-{suffix}"
    second_name = f"opshelper-p2-pg-second-{suffix}"
    password = f"fixture-{secrets.token_hex(24)}"
    active: dict[str, bool] = {}
    cleanup_events: list[dict] = []
    report = {
        "schemaVersion": 1,
        "startedAt": now(),
        "status": "failed",
        "scope": "Disposable postgres:16 containers and a new temporary bind directory; no production schema, existing Compose resource, host port, or external network.",
        "image": IMAGE,
        "fixtureMarker": MARKER,
        "checks": [],
        "sourceDigests": {
            "probeSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
        },
    }
    try:
        image_result = command(["docker", "image", "inspect", IMAGE])
        require_ok(image_result, "inspect postgres image")
        image_info = json.loads(image_result.stdout)[0]
        report["imageId"] = image_info["Id"]
        report["imageDeclaresDataVolume"] = PGDATA_DESTINATION in (image_info.get("Config", {}).get("Volumes") or {})

        create_container(first_name, data_directory, password)
        active[first_name] = True
        if not wait_ready(first_name):
            raise RuntimeError("first disposable PostgreSQL container did not become ready")
        first_inspect = inspect_container(first_name)
        write_result = query(first_name, (
            "CREATE TABLE phase2_bind_fixture (id integer PRIMARY KEY, marker text NOT NULL); "
            f"INSERT INTO phase2_bind_fixture VALUES (1, '{MARKER}'); "
            "SELECT count(*) FROM phase2_bind_fixture;"
        ))
        version = query(first_name, "SHOW server_version;")
        data_path = query(first_name, "SHOW data_directory;")
        first_mount = next((mount for mount in first_inspect["Mounts"] if mount["Destination"] == PGDATA_DESTINATION), None)
        first_stopped, first_removed = remove_container(first_name, running=True)
        cleanup_events.append({"role": "first", "stopped": first_stopped, "removed": first_removed})
        active.pop(first_name, None)
        if not first_stopped or not first_removed:
            raise RuntimeError("first disposable PostgreSQL container was not cleanly stopped and removed")

        create_container(second_name, data_directory, password)
        active[second_name] = True
        if not wait_ready(second_name):
            raise RuntimeError("replacement disposable PostgreSQL container did not become ready")
        second_inspect = inspect_container(second_name)
        restored = query(second_name, "SELECT id || ':' || marker FROM phase2_bind_fixture ORDER BY id;")
        second_mount = next((mount for mount in second_inspect["Mounts"] if mount["Destination"] == PGDATA_DESTINATION), None)

        def mount_summary(item: dict | None) -> dict:
            return {
                "present": item is not None,
                "type": item.get("Type") if item else None,
                "destination": item.get("Destination") if item else None,
                "readWrite": item.get("RW") if item else None,
            }

        first_volumes = [mount for mount in first_inspect["Mounts"] if mount["Type"] == "volume"]
        second_volumes = [mount for mount in second_inspect["Mounts"] if mount["Type"] == "volume"]
        checks = [
            {"name": "fixture row was written before replacement", "passed": write_result.splitlines()[-1] == "1"},
            {"name": "first container stopped and was removed while bind data remained", "passed": first_stopped and first_removed and data_directory.exists()},
            {"name": "replacement container uses the same bind source", "passed": first_mount is not None and second_mount is not None and first_mount["Source"] == second_mount["Source"]},
            {"name": "both containers use bind rather than named or anonymous volume", "passed": first_mount is not None and second_mount is not None and first_mount["Type"] == "bind" and second_mount["Type"] == "bind" and not first_volumes and not second_volumes},
            {"name": "replacement container reads the original fixture row", "passed": restored == f"1:{MARKER}"},
            {"name": "both containers have no network and no published ports", "passed": first_inspect["HostConfig"]["NetworkMode"] == "none" and second_inspect["HostConfig"]["NetworkMode"] == "none" and not first_inspect["HostConfig"].get("PortBindings") and not second_inspect["HostConfig"].get("PortBindings")},
            {"name": "server reports the expected PostgreSQL major version and data directory", "passed": version.split(".")[0] == "16" and data_path == PGDATA_DESTINATION},
        ]
        report.update({
            "postgresVersion": version,
            "reportedDataDirectory": data_path,
            "firstContainer": {
                "networkMode": first_inspect["HostConfig"]["NetworkMode"],
                "hostPortsPublished": bool(first_inspect["HostConfig"].get("PortBindings")),
                "dataMount": mount_summary(first_mount),
                "namedOrAnonymousVolumeCount": len(first_volumes),
            },
            "replacementContainer": {
                "networkMode": second_inspect["HostConfig"]["NetworkMode"],
                "hostPortsPublished": bool(second_inspect["HostConfig"].get("PortBindings")),
                "dataMount": mount_summary(second_mount),
                "namedOrAnonymousVolumeCount": len(second_volumes),
            },
            "replacementUsedSameBindSource": first_mount["Source"] == second_mount["Source"],
            "persistedRow": {"id": 1, "markerMatched": restored == f"1:{MARKER}"},
            "checks": checks,
            "status": "passed" if all(check["passed"] for check in checks) else "failed",
        })
    except Exception as error:
        report["error"] = str(error)
    finally:
        for name, running in list(active.items()):
            stopped, removed = remove_container(name, running=running)
            cleanup_events.append({
                "role": "replacement" if name == second_name else "first",
                "stopped": stopped,
                "removed": removed,
            })
        try:
            directory_removed = remove_probe_tree(temp_root)
        except OSError:
            directory_removed = False
        report["cleanup"] = cleanup_events
        report["containersCreatedCount"] = len(cleanup_events)
        report["containersRemovedCount"] = sum(1 for event in cleanup_events if event["removed"])
        report["temporaryDirectoryRemoved"] = directory_removed
        report["cleanupSucceeded"] = all(event["removed"] for event in cleanup_events) and directory_removed
        report["finishedAt"] = now()
        OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" and report["cleanupSucceeded"] else 1


if __name__ == "__main__":
    sys.exit(main())
