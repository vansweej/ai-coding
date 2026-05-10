# Remote Ollama Access from Oryx → M5

> **Status:** Plan — not yet implemented. Written to capture the design before
> implementation. Challenge items are marked with ⚠️.

---

## Goal

Allow the Oryx machine to transparently use the Ollama instance running on the
M5 Mac over the local home network, falling back to its own localhost Ollama
when the M5 is unreachable.

---

## Design: `resolveOllamaUrl()` with `OLLAMA_REMOTE` fallback

### Two env vars (Option A)

| Env var | Purpose | Fallback |
|---------|---------|----------|
| `OLLAMA_URL` | Explicit override — use this URL, no probing | None (use as-is) |
| `OLLAMA_REMOTE` | Preferred remote — probe first, fall back to localhost | `http://localhost:11434` |

Resolution order:

```
OLLAMA_URL set?    →  use it directly, done (no probe)
      ↓ no
OLLAMA_REMOTE set? →  reachable?  →  yes: use OLLAMA_REMOTE
      ↓ no              ↓ no
http://localhost:11434  ←──────────────┘
```

### What happens when nothing is reachable?

`resolveOllamaUrl()` always returns a string — it never throws. If neither
remote nor localhost responds, it returns `http://localhost:11434` and lets
the subsequent HTTP call fail with a contextual error. The CLIs already have
try/catch around embed calls and produce clear error messages.

### No caching

Each CLI process is short-lived (index + query + exit). Both `codebase-retrieval`
and `skill-retrieval` are spawned as subprocesses by the OpenCode tool on every
invocation, so each call gets a fresh probe automatically. No TTL or module-level
cache is needed.

### Logging

When the function falls back from remote to localhost, it emits:

```
Ollama: remote http://192.168.1.x:11434 unreachable, falling back to localhost
```

---

## Implementation plan

### Files to create

| File | Purpose |
|------|---------|
| `packages/embeddings/src/resolve-ollama-url.ts` | Core `resolveOllamaUrl()` function |
| `packages/embeddings/src/resolve-ollama-url.test.ts` | Unit tests |

### Files to update

| File | Change |
|------|--------|
| `packages/embeddings/src/index.ts` | Export `resolveOllamaUrl` |
| `packages/codebase/src/cli/codebase-retrieval-cli.ts` | Replace manual `isOllamaReachable` + exit with `resolveOllamaUrl()` |
| `packages/codebase/src/indexer/cli.ts` | Same |
| `packages/skills/src/backends/create-backend.ts` | Call `resolveOllamaUrl()` when `ollamaUrl` option is not provided |
| `packages/skills/src/indexer/cli.ts` | Same pattern as codebase CLIs |
| `docs/ollama-models.md` | Add env var table and "Remote Ollama" section |
| `packages/embeddings/README.md` | Document `resolveOllamaUrl()` and env vars |

---

## Step-by-step

### Step 1 — Create `resolve-ollama-url.ts`

```typescript
// packages/embeddings/src/resolve-ollama-url.ts

import { isOllamaReachable } from "./ollama-embedder";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/**
 * Resolve the best available Ollama base URL.
 *
 * Priority:
 *   1. OLLAMA_URL  — explicit override, used as-is, no reachability probe.
 *   2. OLLAMA_REMOTE — probe first; fall back to localhost if unreachable.
 *   3. http://localhost:11434 — default when neither env var is set.
 *
 * Never throws. Always returns a string.
 */
export async function resolveOllamaUrl(): Promise<string> {
  const explicit = process.env.OLLAMA_URL;
  if (explicit) return explicit;

  const remote = process.env.OLLAMA_REMOTE;
  if (remote) {
    const reachable = await isOllamaReachable(remote);
    if (reachable) return remote;
    console.info(`Ollama: remote ${remote} unreachable, falling back to localhost`);
  }

  return DEFAULT_OLLAMA_URL;
}
```

### Step 2 — Export from `index.ts`

```typescript
export { resolveOllamaUrl } from "./resolve-ollama-url";
```

### Step 3 — Update `codebase-retrieval-cli.ts`

Replace:
```typescript
const reachable = await isOllamaReachable();
if (!reachable) {
  console.error("❌  Ollama is not reachable at http://localhost:11434");
  console.error("    Start Ollama with: ollama serve");
  process.exit(1);
}
const embedder = new OllamaEmbedder(model);
```
With:
```typescript
const ollamaUrl = await resolveOllamaUrl();
const embedder = new OllamaEmbedder(model, ollamaUrl);
```

### Step 4 — Update `indexer/cli.ts` (codebase)

Same replacement as Step 3.

### Step 5 — Update `create-backend.ts`

When `ollamaUrl` is not provided by the caller, resolve it first:

```typescript
const resolvedOllamaUrl = ollamaUrl ?? await resolveOllamaUrl();
const [ollamaReachable, dbExists] = await Promise.all([
  isOllamaReachable(resolvedOllamaUrl),
  lanceDbExists(dbPath),
]);
```

### Step 6 — Update `skills/indexer/cli.ts`

Same pattern as codebase CLIs.

### Step 7 — Tests

```typescript
// packages/embeddings/src/resolve-ollama-url.test.ts

describe("resolveOllamaUrl", () => {
  it("returns OLLAMA_URL directly without probing");
  it("returns OLLAMA_REMOTE when reachable");
  it("falls back to localhost when OLLAMA_REMOTE is unreachable");
  it("returns localhost when neither env var is set");
});
```

Mock `fetch` (or `isOllamaReachable`) to control reachability without network
calls.

### Step 8 — Documentation

- `docs/ollama-models.md` — add "Remote Ollama" section with env var table
- `packages/embeddings/README.md` — document `resolveOllamaUrl()` and env vars

---

## Machine setup (one-time)

### M5 (server side)

Start Ollama bound to all interfaces so the Oryx can reach it:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Persist this in your launchd plist or shell rc. Also ensure macOS firewall
allows incoming connections on port 11434 (System Settings → Network →
Firewall → Options → add Ollama or allow port 11434).

### Oryx (client side)

Set in `~/.zshrc` or the Nix home-manager profile for the Oryx machine:

```bash
export OLLAMA_REMOTE="http://<M5-LAN-IP>:11434"
# e.g. export OLLAMA_REMOTE="http://192.168.1.50:11434"
# or using mDNS: export OLLAMA_REMOTE="http://M5.local:11434"
```

No code changes needed on the M5 side — it continues using localhost by default.

---

## Risks and open questions

⚠️ **macOS firewall** — Incoming connections to port 11434 may be blocked by
default. Needs manual allow in System Settings → Network → Firewall.

⚠️ **IP address stability** — If the M5's LAN IP changes, `OLLAMA_REMOTE` breaks.
Consider a static DHCP lease from your router, or use the `.local` mDNS hostname
(`http://M5.local:11434`) which survives IP changes as long as both machines are
on the same subnet.

⚠️ **`OLLAMA_HOST` collision** — Ollama's own CLI also reads `OLLAMA_HOST` (for
server bind address on the M5, and client connect address for `ollama list` etc.).
This design deliberately uses `OLLAMA_URL` (not `OLLAMA_HOST`) for our explicit
override to avoid ambiguity.

⚠️ **`create-backend.ts` double-probe** — After resolving the URL via
`resolveOllamaUrl()` (which probes once), `createBestBackend` calls
`isOllamaReachable(resolvedUrl)` again. Two probes per CLI invocation. Acceptable
for now (each is a 2-second-timeout HEAD request), but worth noting.

⚠️ **Work setup** — This plan is intentionally simple (no auth, no proxy). For
the work network, a reverse proxy with authentication (Caddy + basic auth or
mTLS) will be needed. The `OLLAMA_URL` explicit-override path is already the
right hook for that future setup.

---

## Future work (work setup)

- Caddy / nginx reverse proxy with basic auth or mTLS in front of Ollama
- `OLLAMA_URL` points to the authenticated proxy endpoint
- Possibly a WireGuard or Tailscale tunnel instead of exposing port directly
