#!/usr/bin/env python3
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


def fail(message: str) -> None:
    raise SystemExit(message)


def canonical(raw: str) -> None:
    candidate = Path(raw)
    if not candidate.is_absolute():
        fail(f"路径必须是绝对路径：{raw}")
    print(candidate.resolve(strict=False))


def validated_members(archive: Path, expected_root: str) -> list[tarfile.TarInfo]:
    seen: set[str] = set()
    members: list[tarfile.TarInfo] = []
    with tarfile.open(archive, mode="r:") as source:
        for member in source.getmembers():
            name = member.name.rstrip("/")
            path = PurePosixPath(name)
            if (
                not name
                or path.is_absolute()
                or ".." in path.parts
                or not path.parts
                or path.parts[0] != expected_root
            ):
                fail(f"归档包含越界路径：{member.name}")
            normalized = path.as_posix()
            if normalized in seen:
                fail(f"归档包含重复路径：{member.name}")
            seen.add(normalized)
            if not (member.isdir() or member.isreg()):
                fail(f"归档包含不允许的链接或特殊文件：{member.name}")
            members.append(member)
    if expected_root not in seen:
        fail(f"归档缺少根目录：{expected_root}")
    return members


def validate_metadata(backup_dir: Path, user_id: str) -> None:
    values: dict[str, str] = {}
    metadata = backup_dir / "metadata.txt"
    try:
        lines = metadata.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"无法读取 metadata.txt：{error}")
    for line in lines:
        if "=" not in line:
            fail("metadata.txt 格式无效")
        key, value = line.split("=", 1)
        if key in values:
            fail(f"metadata.txt 包含重复字段：{key}")
        values[key] = value
    if values.get("format") != "opshelper-user-backup-v1":
        fail("备份格式不受支持")
    if values.get("user_id") != user_id:
        fail(
            f"备份用户不匹配：期望 {user_id}，实际 {values.get('user_id', '<missing>')}"
        )


def validate_backup(backup_dir_raw: str, user_id: str) -> None:
    backup_dir = Path(backup_dir_raw)
    validate_metadata(backup_dir, user_id)
    validated_members(backup_dir / "workspace.tar", "workspace")
    validated_members(backup_dir / "state.tar", "state")


def extract(archive_raw: str, expected_root: str, destination_raw: str) -> None:
    archive = Path(archive_raw)
    destination = Path(destination_raw)
    members = validated_members(archive, expected_root)
    directories: list[tuple[Path, tarfile.TarInfo]] = []
    with tarfile.open(archive, mode="r:") as source:
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.name.rstrip("/")).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                directories.append((target, member))
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = source.extractfile(member)
            if extracted is None:
                fail(f"无法读取归档文件：{member.name}")
            try:
                with target.open("xb") as output:
                    shutil.copyfileobj(extracted, output)
                os.chmod(target, member.mode & 0o777)
                os.utime(target, (member.mtime, member.mtime))
            finally:
                extracted.close()
    for target, member in reversed(directories):
        os.chmod(target, member.mode & 0o777)
        os.utime(target, (member.mtime, member.mtime))


def main() -> None:
    if len(sys.argv) < 3:
        fail("缺少校验参数")
    action = sys.argv[1]
    if action == "canonical" and len(sys.argv) == 3:
        canonical(sys.argv[2])
    elif action == "validate-backup" and len(sys.argv) == 4:
        validate_backup(sys.argv[2], sys.argv[3])
    elif action == "validate-archive" and len(sys.argv) == 4:
        validated_members(Path(sys.argv[2]), sys.argv[3])
    elif action == "extract" and len(sys.argv) == 5:
        extract(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        fail("未知的校验操作或参数数量错误")


if __name__ == "__main__":
    main()
