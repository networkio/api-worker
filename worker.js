/**
 * =================================================================================
 * 项目: stockai-2api (Cloudflare Worker 单文件版) — 完整增强版
 * 说明: 这是为个人免费使用而优化的完整 worker.js 文件
 * 变更要点:
 *  - 强制/可选主密钥配置（STRICT_MASTER）
 *  - 内存缓存减少 KV 读取（低频次场景节省额度）
 *  - SSE keepalive（防止 Cloudflare 边缘超时断开）
 *  - 降低限流默认阈值（30/min）
 *  - 隐藏 UI 主密钥（可通过 SHOW_MASTER_KEY=1 显示）
 *  - /v1/admin/apikeys、/v1/admin/metrics、/v1/models、/v1/chat/completions 支持
 * =================================================================================
 */

const CONFIG = {
  PROJECT_NAME: "stockai-2api",
  PROJECT_VERSION: "1.0.0",
  UPSTREAM_ORIGIN: "https://free.stockai.trade",
  UPSTREAM_API_URL: "https://free.stockai.trade/api/chat",
  HEADERS: {
    "authority": "free.stockai.trade",
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "origin": "https://free.stockai.trade",
    "referer": "https://free.stockai.trade/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  },
  MODELS: [
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash",
    "stockai/news",
    "deepseek/deepseek-chat-v3.1",
    "meta/llama-4-scout",
    "moonshotai/kimi-k2",
    "z-ai/glm-4.6",
    "mistral/mistral-small",
    "qwen/qwen3-coder"
  ],
  DEFAULT_MODEL: "openai/gpt-4o-mini",
  DISCLAIMER: "This is a reverse proxy for personal use only. Not affiliated with StockAI."
};

// ---- Simple in-memory cache (per-worker-instance warm cache) ----
const _INMEM = {
  apiKeys: { data: null, expiresAt: 0, ttl: 60 * 1000 }, // 60s
};

// ---- Worker entrypoint ----
export default {
  async fetch(request, env, ctx) {
    // attach env and a small ctx for downstream usage
    request.ctx = { env, startedAt: Date.now() };

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCorsPreflight(request);

    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);

    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found', request);
  }
};

// ---- API routing and logic ----
async function handleApi(request) {
  const env = request.ctx?.env;

  // Authentication
  try {
    if (!(await verifyAuth(request))) {
      return createErrorResponse('Unauthorized', 401, 'auth_error', request);
    }
  } catch (e) {
    // verifyAuth may throw when strict master is enabled but misconfigured
    return createErrorResponse(e.message || 'auth configuration error', 500, 'auth_config_error', request);
  }

  // Rate limiting (skip for master)
  if (!request.ctx?.auth?.isMaster) {
    const rl = await checkRateLimit(request, env);
    if (!rl.allowed) {
      return new Response(JSON.stringify({
        error: { message: `Rate limit exceeded. Try again in ${rl.retryAfter} seconds.`, type: 'rate_limit_exceeded' }
      }), {
        status: 429,
        headers: corsHeaders({ 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter) }, request)
      });
    }
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  // Admin metrics: /v1/admin/metrics
  if (url.pathname === '/v1/admin/metrics') {
    return handleMetricsRequest(request);
  }

  // Models listing
  if (url.pathname === '/v1/models') {
    return handleModelsRequest(request);
  }

  // Chat completions
  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }

  // API Key management (only master allowed)
  if (url.pathname.startsWith('/v1/admin/apikeys')) {
    return handleApiKeysManagement(request);
  }

  return createErrorResponse('Not Found', 404, 'not_found', request);
}

function handleModelsRequest(request) {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'stockai-2api'
    }))
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' }, request)
  });
}

async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const messages = body.messages || [];
    const stream = body.stream !== false; // default true
    const isWebUI = body.is_web_ui === true;

    // Input size check (protect runtime)
    const totalLen = JSON.stringify(messages).length;
    if (totalLen > 20000) {
      return createErrorResponse('Request too large', 413, 'request_too_large', request);
    }

    const convertedMessages = messages.map(msg => ({
      parts: [{ type: "text", text: msg.content }],
      id: generateRandomId(16),
      role: msg.role
    }));

    const payload = {
      model,
      webSearch: false,
      id: generateRandomId(16),
      messages: convertedMessages,
      trigger: "submit-message"
    };

    const upstreamRes = await fetch(CONFIG.UPSTREAM_API_URL, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(payload)
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      throw new Error(`上游服务错误 (${upstreamRes.status}): ${errText}`);
    }

    if (stream) {
      return handleStreamResponse(upstreamRes, model, requestId, isWebUI, request);
    } else {
      return handleNonStreamResponse(upstreamRes, model, requestId, request);
    }
  } catch (e) {
    return createErrorResponse(e.message || 'internal server error', 500, 'internal_error', request);
  }
}

// ---- Stream handling with keepalive ----
function handleStreamResponse(upstreamResponse, model, requestId, isWebUI, request) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let keepAliveTimer = null;
  let closed = false;

  (async () => {
    try {
      // Keepalive every 25s to prevent edge timeouts
      keepAliveTimer = setInterval(async () => {
        if (closed) return;
        try {
          await writer.write(encoder.encode(': keepalive\n\n'));
        } catch (e) {
          clearInterval(keepAliveTimer);
        }
      }, 25000);

      const reader = upstreamResponse.body.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (!dataStr || dataStr === '[DONE]') continue;

            try {
              const data = JSON.parse(dataStr);
              if (data.type === 'text-delta' && data.delta) {
                const chunk = {
                  id: requestId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ index: 0, delta: { content: data.delta }, finish_reason: null }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            } catch (e) {
              // ignore parse errors for individual events
            }
          }
        }
      }

      const endChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
      await writer.write(encoder.encode('data: [DONE]\n\n'));

    } catch (e) {
      const errChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n\n[Error: ${e.message}]` }, finish_reason: "error" }]
      };
      try { await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`)); } catch (_) {}
    } finally {
      closed = true;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      try { await writer.close(); } catch (_) {}
    }
  })();

  return new Response(readable, {
    headers: corsHeaders({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    }, request)
  });
}

// ---- Non-stream handling (aggregate SSE -> single JSON) ----
async function handleNonStreamResponse(upstreamResponse, model, requestId, request) {
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'text-delta' && data.delta) {
              fullText += data.delta;
            }
          } catch (e) { /* ignore single parse errors */ }
        }
      }
    }
  } catch (e) {
    throw new Error(`Stream buffering failed: ${e.message}`);
  }

  const response = {
    id: requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: fullText },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };

  return new Response(JSON.stringify(response), {
    headers: corsHeaders({ 'Content-Type': 'application/json' }, request)
  });
}

// ---- Auth & API Key management ----
async function verifyAuth(request) {
  const headers = request.headers;
  const env = request.ctx?.env;
  const masterKey = env?.API_MASTER_KEY;
  const strict = String(env?.STRICT_MASTER || '').toLowerCase() === '1';

  // Accept Bearer or x-api-key
  const authHeader = headers.get('Authorization') || '';
  let provided = null;
  if (authHeader.startsWith('Bearer ')) provided = authHeader.slice(7).trim();
  else provided = headers.get('x-api-key');

  if (strict && !masterKey) {
    throw new Error('API_MASTER_KEY not configured while STRICT_MASTER=1');
  }

  if (!provided) return false;

  if (masterKey && provided === masterKey) {
    request.ctx.auth = { isMaster: true, key: provided };
    return true;
  }

  const keys = await getStoredApiKeys(env);
  if (Array.isArray(keys)) {
    const item = keys.find(k => k.key === provided || k.id === provided);
    if (item && !item.disabled) {
      request.ctx.auth = { isMaster: false, key: provided, meta: item };
      return true;
    }
  } else if (typeof keys === 'object' && keys !== null) {
    const meta = keys[provided] || Object.values(keys).find(v => v.key === provided || v.id === provided);
    if (meta && !meta.disabled) {
      request.ctx.auth = { isMaster: false, key: provided, meta };
      return true;
    }
  }

  return false;
}

async function getStoredApiKeys(env) {
  const now = Date.now();
  if (_INMEM.apiKeys.data && _INMEM.apiKeys.expiresAt > now) {
    return _INMEM.apiKeys.data;
  }

  // KV first
  if (env?.API_KEYS_KV) {
    try {
      const raw = await env.API_KEYS_KV.get('api_keys');
      if (raw) {
        const parsed = JSON.parse(raw);
        _INMEM.apiKeys = { data: parsed, expiresAt: now + _INMEM.apiKeys.ttl, ttl: _INMEM.apiKeys.ttl };
        return parsed;
      }
    } catch (e) {
      // ignore parse error and fallthrough
    }
  }

  // fallback to env var
  const rawEnv = env?.API_KEYS;
  if (!rawEnv) {
    _INMEM.apiKeys = { data: {}, expiresAt: now + _INMEM.apiKeys.ttl, ttl: _INMEM.apiKeys.ttl };
    return {};
  }
  try {
    const parsed = JSON.parse(rawEnv);
    _INMEM.apiKeys = { data: parsed, expiresAt: now + _INMEM.apiKeys.ttl, ttl: _INMEM.apiKeys.ttl };
    return parsed;
  } catch (e) {
    const arr = rawEnv.split(',').map(s => s.trim()).filter(Boolean);
    const map = {};
    arr.forEach(k => map[k] = { key: k, id: k });
    _INMEM.apiKeys = { data: map, expiresAt: now + _INMEM.apiKeys.ttl, ttl: _INMEM.apiKeys.ttl };
    return map;
  }
}

async function persistStoredApiKeys(env, keys) {
  if (!env?.API_KEYS_KV) return false;
  try {
    await env.API_KEYS_KV.put('api_keys', JSON.stringify(keys));
    // refresh cache
    _INMEM.apiKeys = { data: keys, expiresAt: Date.now() + _INMEM.apiKeys.ttl, ttl: _INMEM.apiKeys.ttl };
    return true;
  } catch (e) {
    return false;
  }
}

async function handleApiKeysManagement(request) {
  const env = request.ctx?.env;
  if (!request.ctx?.auth?.isMaster) {
    return createErrorResponse('Forbidden: master key required for apikey management', 403, 'forbidden', request);
  }

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ["v1","admin","apikeys",":id"?]
  const method = request.method.toUpperCase();

  let keys = await getStoredApiKeys(env);
  let arr = Array.isArray(keys) ? keys.slice() : Object.values(keys || {});

  if (method === 'GET') {
    return new Response(JSON.stringify({ data: arr }), {
      headers: corsHeaders({ 'Content-Type': 'application/json' }, request)
    });
  }

  if (method === 'POST') {
    try {
      const body = await request.json().catch(() => ({}));
      const newKey = generateRandomId(40);
      const id = body.id || generateRandomId(8);
      const meta = {
        key: newKey,
        id,
        name: body.name || `key-${id}`,
        disabled: false,
        created_at: new Date().toISOString(),
        meta: body.meta || {}
      };
      arr.push(meta);
      const persisted = await persistStoredApiKeys(env, arr);
      if (!persisted) {
        return createErrorResponse('KV not configured. Bind API_KEYS_KV to persist keys.', 400, 'no_kv', request);
      }
      return new Response(JSON.stringify({ success: true, key: meta }), {
        headers: corsHeaders({ 'Content-Type': 'application/json' }, request)
      });
    } catch (e) {
      return createErrorResponse(e.message, 500, 'internal_error', request);
    }
  }

  if (method === 'DELETE') {
    const id = parts[3];
    if (!id) return createErrorResponse('Missing key id in path', 400, 'missing_id', request);

    const beforeLen = arr.length;
    arr = arr.filter(k => k.id !== id && k.key !== id);
    if (arr.length === beforeLen) {
      return createErrorResponse('Key not found', 404, 'not_found', request);
    }

    const persisted = await persistStoredApiKeys(env, arr);
    if (!persisted) {
      return createErrorResponse('KV not configured. Bind API_KEYS_KV to persist keys.', 400, 'no_kv', request);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders({ 'Content-Type': 'application/json' }, request)
    });
  }

  return createErrorResponse('Method Not Allowed', 405, 'method_not_allowed', request);
}

// ---- KV-based token-bucket rate limiting (conservative defaults) ----
async function checkRateLimit(request, env) {
  env = env || request.ctx?.env;
  if (!env?.RATE_LIMIT_KV) {
    // No KV => skip limiting (for dev/personal convenience)
    return { allowed: true };
  }

  const identifier = request.headers.get('cf-connecting-ip') ||
                     request.ctx.auth?.key ||
                     'anonymous';
  const BUCKET_KEY = `ratelimit:${identifier}`;

  const RATE_LIMIT = {
    tokensPerInterval: 30, // conservative default: 30/min
    refillInterval: 60000,
    capacity: 30
  };

  const now = Date.now();
  const bucketStr = await env.RATE_LIMIT_KV.get(BUCKET_KEY);
  let bucket = bucketStr ? JSON.parse(bucketStr) : { tokens: RATE_LIMIT.capacity, lastRefill: now };

  const timePassed = now - (bucket.lastRefill || now);
  const cycles = Math.floor(timePassed / RATE_LIMIT.refillInterval);
  if (cycles > 0) {
    const tokensToAdd = cycles * RATE_LIMIT.tokensPerInterval;
    bucket.tokens = Math.min((bucket.tokens || 0) + tokensToAdd, RATE_LIMIT.capacity);
    bucket.lastRefill = (bucket.lastRefill || now) + cycles * RATE_LIMIT.refillInterval;
  }

  if ((bucket.tokens || 0) < 1) {
    const retryAfterMs = RATE_LIMIT.refillInterval - (now - bucket.lastRefill);
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return { allowed: false, retryAfter };
  }

  bucket.tokens = (bucket.tokens || 0) - 1;
  await env.RATE_LIMIT_KV.put(BUCKET_KEY, JSON.stringify(bucket), { expirationTtl: 3600 });

  // increment lightweight metric asynchronously
  incrementMetric(env, 'requests:chat');

  return { allowed: true };
}

// ---- Metrics endpoint ----
async function handleMetricsRequest(request) {
  const env = request.ctx?.env;
  const metrics = [];
  metrics.push(`# HELP worker_requests_total Total number of requests`);
  metrics.push(`# TYPE worker_requests_total counter`);
  let chatCount = 0;
  if (env?.METRICS_KV) {
    try { chatCount = Number(await env.METRICS_KV.get('requests:chat') || 0); } catch (e) { chatCount = 0; }
  }
  metrics.push(`worker_requests_total{endpoint="/v1/chat/completions"} ${chatCount}`);
  metrics.push(`# HELP upstream_api_status Upstream API status`);
  metrics.push(`# TYPE upstream_api_status gauge`);
  metrics.push(`upstream_api_status 1`);
  return new Response(metrics.join('\n'), {
    headers: corsHeaders({ 'Content-Type': 'text/plain; version=0.0.4' }, request)
  });
}

// ---- helpers: generate id, metrics increment ----
function generateRandomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < length; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
  return r;
}

async function incrementMetric(env, key, delta = 1) {
  if (!env?.METRICS_KV) return;
  try {
    const raw = await env.METRICS_KV.get(key);
    const nowVal = raw ? Number(raw) : 0;
    await env.METRICS_KV.put(key, String(nowVal + delta));
  } catch (e) { /* best-effort */ }
}

// ---- Error & CORS helpers ----
function createErrorResponse(msg, status, code, request) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' }, request)
  });
}

function corsHeaders(headers = {}, request) {
  // if no request provided, be permissive
  if (!request) {
    return {
      ...headers,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'X-Disclaimer': CONFIG.DISCLAIMER
    };
  }

  const env = request.ctx?.env;
  const raw = env?.ALLOWED_ORIGINS || '';
  const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
  const requestOrigin = request.headers.get('Origin');

  let allowOrigin = '*';
  if (allowed.length > 0) {
    if (allowed.includes('*')) {
      allowOrigin = requestOrigin || '*';
    } else if (requestOrigin && allowed.includes(requestOrigin)) {
      allowOrigin = requestOrigin;
    } else {
      allowOrigin = allowed[0];
    }
  } else {
    allowOrigin = '*';
  }

  return {
    ...headers,
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'X-Disclaimer': CONFIG.DISCLAIMER
  };
}

function handleCorsPreflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders({}, request) });
}

// ---- UI (developer cockpit) with compliance note; hide master key unless SHOW_MASTER_KEY=1 ----
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const showKey = String(request.ctx?.env?.SHOW_MASTER_KEY || '').toLowerCase() === '1';
  const apiKey = showKey ? (request.ctx?.env?.API_MASTER_KEY || '') : '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${CONFIG.PROJECT_NAME} - 驾驶舱</title>
<style>
:root{--bg:#121212;--panel:#1E1E1E;--border:#333;--text:#E0E0E0;--primary:#FFBF00}
body{font-family:Segoe UI,system-ui,Arial;background:var(--bg);color:var(--text);margin:0;display:flex;height:100vh}
.sidebar{width:380px;background:var(--panel);padding:20px;border-right:1px solid var(--border);overflow:auto}
.main{flex:1;padding:20px;display:flex;flex-direction:column}
.box{background:#252525;padding:12px;border-radius:6px;border:1px solid var(--border);margin-bottom:15px}
.label{font-size:12px;color:#888;margin-bottom:5px;display:block}
.code-block{font-family:monospace;font-size:12px;color:var(--primary);background:#111;padding:8px;border-radius:4px;cursor:pointer;word-break:break-all}
input,select,textarea{width:100%;background:#333;border:1px solid #444;color:#fff;padding:8px;border-radius:4px;margin-bottom:10px;box-sizing:border-box}
button{width:100%;padding:10px;background:var(--primary);border:none;border-radius:4px;color:#000;font-weight:700;cursor:pointer}
.chat-window{flex:1;background:#000;border:1px solid var(--border);border-radius:8px;padding:20px;overflow:auto;display:flex;flex-direction:column;gap:15px}
.msg{max-width:80%;padding:10px 15px;border-radius:8px;line-height:1.5}
.msg.user{align-self:flex-end;background:#333;color:#fff}
.msg.ai{align-self:flex-start;background:#1a1a1a;border:1px solid #333;width:100%;max-width:100%}
.log-panel{height:150px;background:#111;border-top:1px solid var(--border);padding:10px;font-family:monospace;font-size:11px;color:#aaa;overflow:auto}
.disclaimer{font-size:10px;color:#888;margin-top:10px;padding:8px;border-top:1px solid #333}
</style></head><body>
<div class="sidebar">
<h2>🚀 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span></h2>
<div class="box"><span class="label">API 密钥 (点击复制)</span>
<div class="code-block" onclick="copy('${apiKey}')">${apiKey || '⚠️ 未显示（SHOW_MASTER_KEY=0）'}</div></div>
<div class="box"><span class="label">API 接口地址</span>
<div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div></div>
<div class="box">
<span class="label">模型选择</span>
<select id="model">${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
<span class="label">提示词 (Prompt)</span>
<textarea id="prompt" rows="4">你好，请介绍一下你自己。</textarea>
<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
<input type="checkbox" id="stream" checked style="width:auto;margin:0;"><label for="stream" style="margin:0;font-size:12px;color:#ccc;">流式响应 (Stream)</label>
</div>
<button id="btn-gen" onclick="send()">发送请求</button>
</div>
<div class="box">
<span class="label">功能说明</span>
<div style="font-size:12px;color:#888;">
✅ 匿名访问 (无需 Cookie)<br>✅ 支持流式 (SSE) 输出<br>✅ 支持非流式 (适配翻译插件)<br>
</div>
<div class="disclaimer"><strong>合规声明：</strong>本服务仅为个人学习研究用途，使用前请确认遵守 StockAI 服务条款。 不对服务可用性提供保证，不承担任何法律责任。</div>
</div>
</div>
<main class="main">
<div class="chat-window" id="chat"><div style="color:#666;text-align:center;margin-top:50px;">StockAI 代理服务就绪。支持 OpenAI 格式调用。</div></div>
<div class="log-panel" id="logs"></div>
</main>
<script>
const API_KEY = "${apiKey}";
const ENDPOINT = "${origin}/v1/chat/completions";
function log(msg){const el=document.getElementById('logs');const d=document.createElement('div');d.innerHTML='['+new Date().toLocaleTimeString()+'] '+msg;el.appendChild(d);el.scrollTop=el.scrollHeight;}
function copy(text){if(!text) return alert('未配置或未显示主密钥');navigator.clipboard.writeText(text);log('已复制到剪贴板')}
function appendMsg(role,text){const d=document.createElement('div');d.className='msg '+role;d.innerText=text;document.getElementById('chat').appendChild(d);d.scrollIntoView({behavior:"smooth"});return d}
async function send(){
 const prompt=document.getElementById('prompt').value.trim();const model=document.getElementById('model').value;const stream=document.getElementById('stream').checked;
 if(!prompt) return alert('请输入提示词');
 const btn=document.getElementById('btn-gen');btn.disabled=true;btn.innerText='请求中...';
 if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) document.getElementById('chat').innerHTML='';
 appendMsg('user',prompt);const aiMsg=appendMsg('ai','...');let fullText='';
 log('发送请求: '+model+' (Stream:'+stream+')');
 try{
  const res=await fetch(ENDPOINT,{method:'POST',headers:{'Authorization':'Bearer '+API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model, messages:[{role:'user',content:prompt}], stream, is_web_ui:true})});
  if(!res.ok) throw new Error((await res.json()).error?.message||'请求失败');
  if(stream){
    const reader=res.body.getReader();const decoder=new TextDecoder();aiMsg.innerText='';
    while(true){
      const {done,value}=await reader.read(); if(done) break;
      const chunk=decoder.decode(value); const lines=chunk.split('\\n');
      for(const line of lines){ if(line.startsWith('data: ')){ const dataStr=line.slice(6); if(dataStr==='[DONE]') break; try{ const json=JSON.parse(dataStr); const content = json.choices?.[0]?.delta?.content; if(content){ fullText+=content; aiMsg.innerText=fullText } }catch(e){} } }
    }
  } else {
    const data=await res.json(); aiMsg.innerText=data.choices?.[0]?.message?.content || '';
  }
  log('请求完成');
 }catch(e){ aiMsg.innerText='Error: '+e.message; aiMsg.style.color='#CF6679'; log('错误: '+e.message); } finally { btn.disabled=false; btn.innerText='发送请求'; }
}
</script>
</body></html>`;
  return new Response(html, { headers: corsHeaders({ 'Content-Type': 'text/html; charset=utf-8' }, request) });
}
