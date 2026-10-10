#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/bin" "$test_root/live/users/user-1/workspace" "$test_root/live/users/user-1/state"
printf 'workspace-data\n' > "$test_root/live/users/user-1/workspace/report.txt"
printf 'state-data\n' > "$test_root/live/users/user-1/state/session.db"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ "$*" == *".State.Running"* ]]; then printf "%s\n" "${FAKE_RUNNING:-false}"; exit 0; fi' \
  'if [[ "$*" == *"opshelper.userId"* ]]; then printf "%s\n" "${FAKE_USER_ID:-user-1}"; exit 0; fi' \
  'exit 1' \
  > "$test_root/bin/docker"
chmod +x "$test_root/bin/docker"

PATH="$test_root/bin:$PATH" DATA_ROOT_HOST="$test_root/live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" backup user-1 test-user-1 "$test_root/backup"

test -f "$test_root/backup/workspace.tar"
test -f "$test_root/backup/state.tar"
test -f "$test_root/backup/manifest.sha256"

PATH="$test_root/bin:$PATH" DATA_ROOT_HOST="$test_root/live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" restore user-1 test-user-1 \
  "$test_root/backup" "$test_root/restored"
cmp "$test_root/live/users/user-1/workspace/report.txt" \
  "$test_root/restored/users/user-1/workspace/report.txt"
cmp "$test_root/live/users/user-1/state/session.db" \
  "$test_root/restored/users/user-1/state/session.db"

if PATH="$test_root/bin:$PATH" DATA_ROOT_HOST="$test_root/live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" restore user-1 test-user-1 \
  "$test_root/backup" "$test_root/restored" >/dev/null 2>&1; then
  echo "非空恢复目标本应被拒绝" >&2
  exit 1
fi

if PATH="$test_root/bin:$PATH" FAKE_RUNNING=true DATA_ROOT_HOST="$test_root/live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" backup user-1 test-user-1 \
  "$test_root/backup-running" >/dev/null 2>&1; then
  echo "运行中的容器本应被拒绝" >&2
  exit 1
fi

if PATH="$test_root/bin:$PATH" FAKE_USER_ID=user-2 DATA_ROOT_HOST="$test_root/live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" backup user-1 test-user-1 \
  "$test_root/backup-wrong-user" >/dev/null 2>&1; then
  echo "用户标签不匹配的容器本应被拒绝" >&2
  exit 1
fi

if PATH="$test_root/bin:$PATH" DATA_ROOT_HOST="$test_root/live/../live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" backup user-1 test-user-1 \
  "$test_root/live/../live/alias-backup" >/dev/null 2>&1; then
  echo "经 .. 指回当前数据根的备份路径本应被拒绝" >&2
  exit 1
fi

ln -s "$test_root/live" "$test_root/live-alias"
if PATH="$test_root/bin:$PATH" DATA_ROOT_HOST="$test_root/live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" backup user-1 test-user-1 \
  "$test_root/live-alias/alias-backup" >/dev/null 2>&1; then
  echo "经符号链接指回当前数据根的备份路径本应被拒绝" >&2
  exit 1
fi

mkdir -p "$test_root/malicious-path" "$test_root/malicious-link"
python3 -c '
import io, sys, tarfile
archive, name, kind = sys.argv[1:]
with tarfile.open(archive, "w:") as output:
    root = tarfile.TarInfo("workspace")
    root.type = tarfile.DIRTYPE
    output.addfile(root)
    item = tarfile.TarInfo(name)
    if kind == "file":
        payload = b"escape"
        item.size = len(payload)
        output.addfile(item, io.BytesIO(payload))
    else:
        item.type = tarfile.SYMTYPE
        item.linkname = "../../outside"
        output.addfile(item)
' "$test_root/malicious-path/workspace.tar" "workspace/../escape" file

python3 -c '
import sys, tarfile
archive = sys.argv[1]
with tarfile.open(archive, "w:") as output:
    root = tarfile.TarInfo("workspace")
    root.type = tarfile.DIRTYPE
    output.addfile(root)
    link = tarfile.TarInfo("workspace/link")
    link.type = tarfile.SYMTYPE
    link.linkname = "../../outside"
    output.addfile(link)
' "$test_root/malicious-link/workspace.tar"

if python3 "$repo_root/scripts/runtime-probes/user-backup-validate.py" validate-archive \
  "$test_root/malicious-path/workspace.tar" workspace >/dev/null 2>&1; then
  echo "包含 .. 的归档路径本应被拒绝" >&2
  exit 1
fi

if python3 "$repo_root/scripts/runtime-probes/user-backup-validate.py" validate-archive \
  "$test_root/malicious-link/workspace.tar" workspace >/dev/null 2>&1; then
  echo "归档内符号链接本应被拒绝" >&2
  exit 1
fi

cp -R "$test_root/backup" "$test_root/wrong-metadata"
sed 's/^user_id=.*/user_id=user-2/' "$test_root/wrong-metadata/metadata.txt" \
  > "$test_root/wrong-metadata/metadata.changed"
mv "$test_root/wrong-metadata/metadata.changed" "$test_root/wrong-metadata/metadata.txt"
if PATH="$test_root/bin:$PATH" DATA_ROOT_HOST="$test_root/live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" restore user-1 test-user-1 \
  "$test_root/wrong-metadata" "$test_root/wrong-metadata-restore" >/dev/null 2>&1; then
  echo "用户 ID 不匹配的备份元数据本应被拒绝" >&2
  exit 1
fi

mkdir -p "$test_root/symlink-restore-target"
ln -s "$test_root/symlink-restore-target" "$test_root/restore-alias"
if PATH="$test_root/bin:$PATH" DATA_ROOT_HOST="$test_root/live" \
  "$repo_root/scripts/runtime-probes/user-backup.sh" restore user-1 test-user-1 \
  "$test_root/backup" "$test_root/restore-alias" >/dev/null 2>&1; then
  echo "符号链接恢复根本应被拒绝" >&2
  exit 1
fi

echo "user-backup tests passed"
