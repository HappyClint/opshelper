#!/usr/bin/env bash
set -euo pipefail

# Prevent macOS tar from adding AppleDouble ._ entries outside the expected
# workspace/state roots.
export COPYFILE_DISABLE=1

usage() {
  cat >&2 <<'EOF'
用法：
  DATA_ROOT_HOST=/absolute/live/data user-backup.sh backup <user-id> <container-name> <backup-dir>
  DATA_ROOT_HOST=/absolute/live/data user-backup.sh restore <user-id> <container-name> <backup-dir> <restore-data-root>

只备份或恢复 users/<user-id>/{workspace,state}。操作前必须停止该测试用户容器；
脚本会通过 Docker 检查容器状态和 opshelper.userId 标签。恢复目录必须独立于当前
DATA_ROOT_HOST，且 users/<user-id> 不存在或为空。
EOF
  exit 2
}

fail() {
  echo "$*" >&2
  exit 1
}

require_absolute() {
  [[ "$2" == /* ]] || fail "$1 必须是绝对路径：$2"
}

assert_safe_user_id() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]] || fail "用户 ID 不安全：$1"
}

assert_stopped_user_container() {
  local user_id="$1"
  local container_name="$2"
  command -v docker >/dev/null 2>&1 || fail "找不到 docker，无法验证测试容器已停止"

  local running
  running="$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null)" \
    || fail "无法检查容器：$container_name"
  [[ "$running" == "false" ]] || fail "容器仍在运行，请先停止：$container_name"

  local owner
  owner="$(docker inspect --format '{{ index .Config.Labels "opshelper.userId" }}' "$container_name" 2>/dev/null)" \
    || fail "无法读取容器用户标签：$container_name"
  [[ "$owner" == "$user_id" ]] || fail "容器用户标签不匹配：期望 $user_id，实际 $owner"
}

assert_independent() {
  local live_root="${1%/}"
  local other="${2%/}"
  [[ "$other" != "$live_root" ]] || fail "备份/恢复路径不能使用当前 DATA_ROOT_HOST"
  [[ "$other/" != "$live_root/"* ]] || fail "备份/恢复路径不能位于当前 DATA_ROOT_HOST 内"
  [[ "$live_root/" != "$other/"* ]] || fail "备份/恢复路径不能包含当前 DATA_ROOT_HOST"
}

hash_archives() {
  local directory="$1"
  (
    cd "$directory"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum workspace.tar state.tar > manifest.sha256
    else
      shasum -a 256 workspace.tar state.tar > manifest.sha256
    fi
  )
}

verify_archives() {
  local directory="$1"
  (
    cd "$directory"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c manifest.sha256 >/dev/null
    else
      shasum -a 256 -c manifest.sha256 >/dev/null
    fi
  )
}

[[ $# -ge 4 ]] || usage
action="$1"
user_id="$2"
container_name="$3"
backup_dir="$4"
live_root="${DATA_ROOT_HOST:-}"
helper="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/user-backup-validate.py"

[[ -n "$live_root" ]] || fail "必须设置 DATA_ROOT_HOST"
require_absolute DATA_ROOT_HOST "$live_root"
require_absolute backup-dir "$backup_dir"
command -v python3 >/dev/null 2>&1 || fail "找不到 python3，无法安全检查备份路径和归档"
[[ ! -L "$live_root" ]] || fail "DATA_ROOT_HOST 不能是符号链接：$live_root"
[[ ! -L "$backup_dir" ]] || fail "备份目录不能是符号链接：$backup_dir"
live_root="$(python3 "$helper" canonical "$live_root")"
backup_dir="$(python3 "$helper" canonical "$backup_dir")"
assert_safe_user_id "$user_id"
assert_independent "$live_root" "$backup_dir"
assert_stopped_user_container "$user_id" "$container_name"

case "$action" in
  backup)
    [[ $# -eq 4 ]] || usage
    source_root="${live_root%/}/users/$user_id"
    [[ ! -L "$source_root" ]] || fail "用户数据根不能是符号链接：$source_root"
    [[ -d "$source_root/workspace" && ! -L "$source_root/workspace" ]] \
      || fail "workspace 不存在或不是安全目录：$source_root/workspace"
    [[ -d "$source_root/state" && ! -L "$source_root/state" ]] \
      || fail "state 不存在或不是安全目录：$source_root/state"
    [[ ! -e "$backup_dir" ]] || fail "备份目标已存在，拒绝覆盖：$backup_dir"

    mkdir -p "$backup_dir"
    tar -C "$source_root" -cpf "$backup_dir/workspace.tar" workspace
    tar -C "$source_root" -cpf "$backup_dir/state.tar" state
    hash_archives "$backup_dir"
    printf '%s\n' \
      "format=opshelper-user-backup-v1" \
      "user_id=$user_id" \
      "container=$container_name" \
      "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$backup_dir/metadata.txt"
    echo "用户离线备份已写入：$backup_dir"
    ;;
  restore)
    [[ $# -eq 5 ]] || usage
    restore_root="$5"
    require_absolute restore-data-root "$restore_root"
    [[ ! -L "$restore_root" ]] || fail "恢复数据根不能是符号链接：$restore_root"
    restore_root="$(python3 "$helper" canonical "$restore_root")"
    assert_independent "$live_root" "$restore_root"
    [[ -f "$backup_dir/workspace.tar" && -f "$backup_dir/state.tar" ]] \
      || fail "备份不完整：缺少 workspace.tar 或 state.tar"
    [[ -f "$backup_dir/manifest.sha256" ]] || fail "备份不完整：缺少 manifest.sha256"
    verify_archives "$backup_dir" || fail "备份校验失败"
    python3 "$helper" validate-backup "$backup_dir" "$user_id" \
      || fail "备份内容校验失败"

    target_root="${restore_root%/}/users/$user_id"
    [[ ! -L "$target_root" ]] || fail "恢复目标不能是符号链接：$target_root"
    if [[ -e "$target_root" && ! -d "$target_root" ]]; then
      fail "恢复目标不是目录：$target_root"
    fi
    if [[ -d "$target_root" && -n "$(find "$target_root" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      fail "恢复目标非空，拒绝覆盖：$target_root"
    fi
    mkdir -p "$target_root"
    python3 "$helper" extract "$backup_dir/workspace.tar" workspace "$target_root"
    python3 "$helper" extract "$backup_dir/state.tar" state "$target_root"
    echo "用户备份已恢复到独立目录：$target_root"
    ;;
  *) usage ;;
esac
