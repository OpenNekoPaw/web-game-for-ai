#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary_path="${BINARY_PATH:-$project_root/dist/ddz-server}"
port="${BINARY_TEST_PORT:-31873}"
test_dir="$(mktemp -d)"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$test_dir"
}
trap cleanup EXIT

if [[ ! -x "$binary_path" ]]; then
  echo "Binary is missing or not executable: $binary_path" >&2
  exit 1
fi
(
  cd "$test_dir"
  exec env PORT="$port" REPLAY_PERSISTENCE=memory "$binary_path"
) >"$test_dir/server.log" 2>&1 &
server_pid=$!

base_url="http://127.0.0.1:$port"
for _ in {1..30}; do
  if curl --fail --silent --output /dev/null "$base_url/"; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$test_dir/server.log" >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent --output /dev/null "$base_url/"
curl --fail --silent --output /dev/null "$base_url/public/app.js"
curl --fail --silent "$base_url/api/agent-guide" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk).on('end', () => { const data = JSON.parse(value); if (data.fileName !== 'SKILL.md' || !data.markdown || !data.hash) process.exit(1); });"
curl --fail --silent "$base_url/agent/v1/strategies" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk).on('end', () => { const data = JSON.parse(value); if (!data.defaultStrategyId || !data.strategies?.length) process.exit(1); });"
game_json="$(curl --fail --silent --request POST --header 'content-type: application/json' --data '{}' "$base_url/agent/v1/games")"
game_id="$(printf '%s' "$game_json" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk).on('end', () => { const data = JSON.parse(value); if (!data.gameId || data.protocol !== 'agent-game.v1') process.exit(1); process.stdout.write(data.gameId); });")"
invite_json="$(curl --fail --silent --request POST --header 'content-type: application/json' --data '{"inviteType":"agent","seatId":0}' "$base_url/api/games/$game_id/invites")"
invite_token="$(printf '%s' "$invite_json" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk).on('end', () => { const data = JSON.parse(value); if (data.protocol !== 'agent-game.invite.v1' || data.inviteType !== 'agent') process.exit(1); process.stdout.write(data.token); });")"
curl --fail --silent "$base_url/agent/v1/invites/$invite_token" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk).on('end', () => { const data = JSON.parse(value); if (data.gameId !== '$game_id' || data.seatId !== 0) process.exit(1); });"
curl --fail --silent --request POST --header 'content-type: application/json' --data '{"agentId":"binary-smoke-agent","displayName":"Binary Smoke"}' "$base_url/agent/v1/invites/$invite_token/join" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk).on('end', () => { const data = JSON.parse(value); if (data.seatControllers?.[0]?.id !== 'binary-smoke-agent' || data.strategy !== null) process.exit(1); });"
curl --fail --silent --request POST --header 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$base_url/mcp" | node -e "let value=''; process.stdin.on('data', chunk => value += chunk).on('end', () => { const data = JSON.parse(value); const tools = data.result?.tools || []; if (!tools.some(tool => tool.name === 'join_invite') || tools.some(tool => tool.name === 'get_local_strategy')) process.exit(1); });"

echo "Binary smoke test passed"
