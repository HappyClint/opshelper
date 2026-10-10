#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
data_root="${1:-${DATA_ROOT_HOST:-$repo_root/data}}"

if [[ "$data_root" != /* ]]; then
  echo "DATA_ROOT_HOST 必须是宿主机绝对路径：$data_root" >&2
  exit 1
fi

if [[ -L "$data_root" ]]; then
  echo "数据根目录不能是符号链接：$data_root" >&2
  exit 1
fi

umask 027
mkdir -p \
  "$data_root/postgres" \
  "$data_root/agents" \
  "$data_root/config/opencode" \
  "$data_root/users" \
  "$data_root/backups"

for required in postgres agents config config/opencode users backups; do
  target="$data_root/$required"
  if [[ ! -d "$target" || -L "$target" ]]; then
    echo "数据路径必须是真实目录，不能是符号链接：$target" >&2
    exit 1
  fi
done

chmod 750 "$data_root" "$data_root/agents" "$data_root/config" \
  "$data_root/config/opencode" "$data_root/users"
# PostgreSQL 目录会在容器启动前由 postgres-init 收敛为 999:999、0700。
# 这里不重复 chmod，避免已启动过的部署再次执行本脚本时因目录归属变化而失败。
chmod 700 "$data_root/backups"

current_uid="$(id -u)"
current_gid="$(id -g)"
configured_uid="${OPSHELPER_UID:-$current_uid}"
configured_gid="${OPSHELPER_GID:-$current_gid}"

if [[ "$configured_uid" != "$current_uid" || "$configured_gid" != "$current_gid" ]]; then
  echo "警告：OPSHELPER_UID:GID=$configured_uid:$configured_gid，与当前目录所有者 $current_uid:$current_gid 不同。" >&2
  echo "请在启动前修正 .env 或目录所有权，否则 API/用户运行时可能无法写入。" >&2
fi

echo "数据目录已准备：$data_root"
echo "请在 .env 设置：DATA_ROOT_HOST=$data_root"
echo "容器内 DATA_ROOT 固定为 /data；不要把 /data 写入 DATA_ROOT_HOST。"
