#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

output="$("$repo_root/scripts/prepare-data.sh" "$test_root/data")"
for required in postgres agents config/opencode users backups; do
  test -d "$test_root/data/$required"
  test ! -L "$test_root/data/$required"
done
grep -F "DATA_ROOT_HOST=$test_root/data" <<<"$output" >/dev/null

if "$repo_root/scripts/prepare-data.sh" relative/data >/dev/null 2>&1; then
  echo "相对路径本应被拒绝" >&2
  exit 1
fi

ln -s "$test_root/data" "$test_root/link"
if "$repo_root/scripts/prepare-data.sh" "$test_root/link" >/dev/null 2>&1; then
  echo "符号链接数据根本应被拒绝" >&2
  exit 1
fi

echo "prepare-data tests passed"
