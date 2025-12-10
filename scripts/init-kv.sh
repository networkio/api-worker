#!/usr/bin/env bash
# 使用 wrangler CLI 向已绑定的 KV 写入初始 api_keys
# 先确保你已经用 wrangler 登录并且 wrangler.toml 中已填入 namespace id
# 用法: bash scripts/init-kv.sh

set -e

# 初始 keys 列表（示例：两个 key）
read -r -d '' PAYLOAD <<'JSON'
[
  {
    "key": "dev-example-key-1",
    "id": "dev-1",
    "name": "dev-key-1",
    "disabled": false,
    "created_at": "2025-12-10T00:00:00Z",
    "meta": { "owner": "dev" }
  }
]
JSON

echo "写入 API_KEYS_KV -> key: api_keys ..."
# wrangler kv:key put --binding API_KEYS_KV <key> <value>
# wrangler v3 命令可能为 `wrangler kv:key put` 或 `wrangler kv:key put --binding API_KEYS_KV`
# 以下命令在多数 wrangler 版本可用：
printf "%s" "$PAYLOAD" | wrangler kv:key put --binding API_KEYS_KV api_keys --path=-
echo "完成。请在 Cloudflare Dashboard 中验证 API_KEYS_KV 中的键 'api_keys' 已存在。"
