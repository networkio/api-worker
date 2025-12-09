# Repository Guidelines

## Project Structure & Module Organization
- `worker.js`: Single-file Cloudflare Worker containing routing, OpenAI-compatible proxy logic, SSE → JSON handling, and the built-in cockpit UI. Treat it as the source of truth.
- `README.md`: User-facing deployment and usage guide; keep it aligned with code changes.
- `LICENSE`: Apache 2.0; retain headers when adding files. Add new modules only if necessary—prefer keeping the worker lean.

## Build, Test, and Development Commands
- Local preview: `wrangler dev worker.js --remote` (uses your Cloudflare account; good for SSE behavior).
- Edge deploy: `wrangler publish worker.js` (ensure secrets are set first).
- Quick smoke tests (from a shell):  
  - Models: `curl -H "Authorization: Bearer 1" "$WORKER_URL/v1/models"`  
  - Chat stream: `curl -N -H "Authorization: Bearer 1" -H "Content-Type: application/json" -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"ping"}],"stream":true}' "$WORKER_URL/v1/chat/completions"`

## Coding Style & Naming Conventions
- Language: modern JavaScript (ES2022) targeting Workers runtime; avoid Node-only APIs.
- Indentation 2 spaces; prefer double quotes; keep semicolons.
- Functions camelCase; constants SCREAMING_SNAKE_CASE; keep config in the `CONFIG` object.
- Keep comments short and purposeful; avoid non-ASCII unless mirroring existing text.

## Testing Guidelines
- No automated suite yet—add focused tests when modifying stream parsing or auth. Favor small harnesses that call the Worker via `wrangler dev --remote`.
- Validate both `stream=true` (SSE chunking) and `stream=false` (buffered JSON) flows; confirm `[DONE]` handling and error surfaces.
- When changing headers or auth, verify `Authorization` fallback to `API_MASTER_KEY` still works.

## Commit & Pull Request Guidelines
- Follow the existing history style: short, imperative summaries (e.g., `Update README.md`, `Create worker.js`).
- Include a brief PR description: intent, main changes, and any config impacts.
- Link related issues if applicable; attach curl transcripts or screenshots from the cockpit UI for behavior changes.
- Keep diffs minimal; avoid unnecessary reformatting of the monolithic `worker.js`.

## Security & Configuration Tips
- Secrets: set `API_MASTER_KEY` (or custom key) in Worker vars; do not hardcode sensitive values in commits.
- Upstream: default target is `https://free.stockai.trade`; if you swap upstreams, update headers and document the change.
- CORS is permissive (`*`); if you tighten it, confirm cockpit UI and external clients still function.
