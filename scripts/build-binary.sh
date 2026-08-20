#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${BINARY_OUTPUT_DIR:-$project_root/dist}"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required: https://bun.sh" >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
if [[ "$output_dir" == "/" || "$output_dir" == "$project_root" ]]; then
  echo "Refusing unsafe output directory: $output_dir" >&2
  exit 1
fi
rm -rf "$output_dir/share"
mkdir -p "$output_dir/share/.agents/skills"

bun build "$project_root/server.js" --compile --outfile "$output_dir/ddz-server-worker"
bun build "$project_root/scripts/supervise-server.js" --compile --outfile "$output_dir/ddz-server"
cp -R "$project_root/public" "$output_dir/share/public"
cp -R "$project_root/strategies" "$output_dir/share/strategies"
cp -R "$project_root/.agents/skills/play-doudizhu" "$output_dir/share/.agents/skills/play-doudizhu"

echo "Binary distribution created at $output_dir"
