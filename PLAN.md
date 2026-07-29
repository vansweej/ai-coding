# Feature: opencode-free model profile (OpenCode Zen)

## Phase 1: Profile definition

Commit message: feat: add opencode-free model profile

### Step 1: Add OPENCODE_FREE_PROFILE constant and register it

File to modify: `ai-system/config/model-profiles.ts`.

Context: This file defines `type ModelRole = "planner" | "implementer" | "debugger" | "fixer" | "reviewer" | "tester" | "scaffolder" | "explorer" | "default"` and `interface ModelProfile { readonly name: string; readonly roles: Readonly<Record<ModelRole, string>> }`. It already contains constants like `BEDROCK_SONNET_PROFILE` and a registry `export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>>`.

After the `BEDROCK_SONNET_PROFILE` constant, add a new exported constant `OPENCODE_FREE_PROFILE: ModelProfile` with `name: "opencode-free"` and every one of the 9 roles set to the string literal `"opencode-free"` (a stable logical token, NOT a real model ID). Add a doc comment above it, modeled on the existing `BEDROCK_SONNET_PROFILE` comment, stating: all roles route to a free OpenCode Zen model via the OpenAI-compatible chat/completions endpoint; the concrete model ID is resolved at wiring time from the `OPENCODE_ZEN_MODEL` environment variable (never hardcoded here), so swapping the free model when it rotates out is a one-line env change; auth is a Bearer API key from `OPENCODE_ZEN_API_KEY`.

Then add `[OPENCODE_FREE_PROFILE.name]: OPENCODE_FREE_PROFILE,` as a new entry in the `MODEL_PROFILES` record. Do not change `DEFAULT_PROFILE_NAME`.

## Phase 2: OpenCode Zen dispatcher

Commit message: feat: add OpenCodeZenDispatcher for Zen chat/completions

### Step 1: Create the OpenCodeZenDispatcher class

Create a new file: `ai-system/core/orchestrator/opencode-zen-dispatcher.ts`.

Before writing, open `ai-system/shared/event-types.ts` and confirm these exact signatures (import them from `@ai-coding/shared`): `interface DispatchRequest { readonly model: string; readonly prompt: string; readonly system?: string; readonly temperature?: number; readonly maxTokens?: number; readonly context?: Record<string, unknown> }`; `interface ModelDispatcher { dispatch(request: DispatchRequest): Promise<Result<string>> }`; `type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }`.

Implement the file: import `DispatchRequest`, `ModelDispatcher`, `Result` from `@ai-coding/shared`. Define constants `ZEN_CHAT_URL = "https://opencode.ai/zen/v1/chat/completions"` and `DEFAULT_MAX_TOKENS = 8192`. Define readonly interfaces `OpenAIChoice { readonly message: { readonly content: string } }` and `OpenAIChatResponse { readonly choices: readonly OpenAIChoice[] }`.

Export `class OpenCodeZenDispatcher implements ModelDispatcher` with private readonly fields `apiKey: string`, `model: string`, `endpoint: string`. Constructor `(apiKey: string, model: string, endpoint: string = ZEN_CHAT_URL)`. Class doc comment: dispatches to OpenCode Zen via the OpenAI-compatible endpoint; the concrete model (e.g. `deepseek-v4-flash-free`) is a constructor argument resolved from an env var by the caller, so `request.model` (the logical token) is intentionally ignored and `this.model` is always sent; system prompt is a message (not a top-level field); response is read from `choices[0].message.content`; auth is a Bearer API key.

Implement `async dispatch(request: DispatchRequest): Promise<Result<string>>`, structured like `ai-system/core/orchestrator/anthropic-dispatcher.ts` but OpenAI-style: (1) build `const messages: Array<{ role: string; content: string }> = []`; if `request.system !== undefined` push `{ role: "system", content: request.system }`; then always push `{ role: "user", content: request.prompt }`. (2) body `= { model: this.model, messages, max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS, stream: false }` (typed `Record<string, unknown>`); add `body.temperature = request.temperature` only when `request.temperature !== undefined`. (3) `await fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: \`Bearer ${this.apiKey}\`, "User-Agent": "ai-coding-os/1.0.0" }, body: JSON.stringify(body) })`. (4) if `!response.ok` return `{ ok: false, error: new Error(\`OpenCode Zen returned ${response.status}: ${await response.text()}\`) }`. (5) parse `(await response.json()) as OpenAIChatResponse`; read `data.choices[0]?.message.content`; if `undefined` return an error Result whose message contains `"no content"`; else return `{ ok: true, value: content }`. Wrap in try/catch; catch returns `{ ok: false, error: error instanceof Error ? error : new Error(String(error)) }`. Trust the standard OpenAI shape — no defensive top-level-error-object parsing. Never throw.

## Phase 3: Config wiring

Commit message: feat: wire opencode-free dispatcher in load-config

### Step 1: Add Zen model detection and dispatcher wiring in load-config.ts

File to modify: `ai-system/cli/load-config.ts`.

Context: This module resolves a profile via `findProfile`, computes `const modelIds = [...new Set(Object.values(profile.roles))]`, partitions IDs per provider (existing sets `COPILOT_MODEL_IDS`, `ANTHROPIC_MODEL_IDS`, `BEDROCK_MODEL_IDS` with predicates `isCopilotModel`/`isAnthropicModel`/`isBedrockModel`), runs Ollama preflight for the remaining IDs, does env fail-fast checks per provider, then builds `const dispatchers: Record<string, ModelDispatcher> = {}` keyed by model-ID string. CRITICAL invariant: `orchestrate.ts` looks up `config.dispatchers[model]` where `model` is the logical token returned by role resolution — so the dispatcher map key MUST be the token `"opencode-free"`, not the concrete model.

Changes: (1) Add import `import { OpenCodeZenDispatcher } from "../core/orchestrator/opencode-zen-dispatcher";`. (2) Near the other model-ID sets, add `const OPENCODE_ZEN_MODEL_IDS = new Set(["opencode-free"]);`. (3) Near the other predicates, add `function isOpenCodeZenModel(modelId: string): boolean { return OPENCODE_ZEN_MODEL_IDS.has(modelId); }` with a doc comment. (4) In the `ollamaModelIds` filter predicate — currently excludes Copilot/Anthropic/Bedrock — also add `&& !isOpenCodeZenModel(id)` so the Zen token never triggers Ollama preflight. (5) After the `bedrockModelIds` filter, add `const zenModelIds = modelIds.filter((id) => isOpenCodeZenModel(id));`. (6) Declare `let zenApiKey: string | undefined;` and `let zenModel: string | undefined;`; after the Bedrock env-check block add: if `zenModelIds.length > 0` — set `zenApiKey = process.env.OPENCODE_ZEN_API_KEY`; if falsy return `{ ok: false, error: new Error("OpenCode Zen models require OPENCODE_ZEN_API_KEY environment variable to be set. Sign in at https://opencode.ai/auth and export your Zen API key before retrying.") }`; then set `zenModel = process.env.OPENCODE_ZEN_MODEL`; if falsy return `{ ok: false, error: new Error("OpenCode Zen models require OPENCODE_ZEN_MODEL environment variable to be set (e.g. deepseek-v4-flash-free).") }`. (7) In the dispatcher-wiring section, after the Bedrock binding: if `zenApiKey !== undefined && zenModel !== undefined`, construct `const zen = new OpenCodeZenDispatcher(zenApiKey, zenModel);` and `for (const id of zenModelIds) dispatchers[id] = zen;`.

## Phase 4: CLI usage documentation

Commit message: docs: document opencode-free profile in CLI usage

### Step 1: Add opencode-free to the parse-args USAGE block

File to modify: `ai-system/cli/parse-args.ts`.

Context: exports a `USAGE` template string containing a "Profile names:" section listing `local`, `hybrid`, `copilot-default`, `anthropic-sonnet`, `bedrock-sonnet` with indented descriptions.

After the `bedrock-sonnet` entry, add an `opencode-free` line matching the existing indentation and wording style: all roles route to a free OpenCode Zen model via the OpenAI-compatible chat/completions endpoint; requires `OPENCODE_ZEN_API_KEY` and `OPENCODE_ZEN_MODEL` (e.g. `deepseek-v4-flash-free`) environment variables.

## Phase 5: Tests

Commit message: test: cover opencode-free profile, dispatcher, and wiring

### Step 1: Test the OpenCodeZenDispatcher

Create `ai-system/core/orchestrator/opencode-zen-dispatcher.test.ts`, modeled on `ai-system/core/orchestrator/anthropic-dispatcher.test.ts`.

Setup: `import { afterEach, beforeEach, describe, expect, it } from "bun:test"`; `import type { DispatchRequest } from "@ai-coding/shared"`; `import { OpenCodeZenDispatcher } from "./opencode-zen-dispatcher"`. Save `const originalFetch = global.fetch`; `beforeEach` sets `global.fetch` to an async fn that throws `new Error("fetch not mocked")`; `afterEach` restores `originalFetch`. Construct with `new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free")`. Use the capture-body pattern (mock fetch records `JSON.parse((options as RequestInit).body as string)`).

Success responses mock `{ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Hello!" } }] }) }`. Cover: (1) constructs with defaults; (2) success path returns the content; (3) system prompt → `messages[0].role === "system"`, user → `messages[1].role === "user"`, `messages.length === 2`; (4) with no system prompt, `messages.length === 1` and `messages[0].role === "user"`; (5) body `model` equals `"deepseek-v4-flash-free"` (the constructor model, NOT `request.model` — pass a different `request.model` to prove it's ignored); (6) `max_tokens` defaults to 8192; uses provided `maxTokens` when set; (7) `temperature` present only when provided; (8) `stream === false`; (9) `Authorization` header equals `"Bearer test-key"`; (10) uses a custom endpoint when constructed with one. Error branches: (11) non-ok status (e.g. 401, `text: async () => "Unauthorized"`) → `!result.ok` and message contains `"401"`; (12) `choices: []` → message contains `"no content"`; (13) `choices: [{ message: { content: undefined } }]` → `"no content"`; (14) fetch throws `new Error("Network error")` → message contains `"Network error"`; (15) `json` throws `new Error("Invalid JSON")` → propagated; (16) fetch throws a plain string `"plain string error"` → message contains that string (covers the `error instanceof Error` false branch).

### Step 2: Test load-config wiring for opencode-free

Add cases to `ai-system/cli/load-config.test.ts`, following the existing Bedrock/Anthropic env-check cases as the template. Around each test, save and restore `process.env.OPENCODE_ZEN_API_KEY` and `process.env.OPENCODE_ZEN_MODEL` (set in the test body; delete/restore afterward) so env state does not leak. Cases: (1) both env vars set → `loadConfig("opencode-free")` returns `ok: true` and `value.dispatchers["opencode-free"]` is defined; (2) `OPENCODE_ZEN_API_KEY` unset → `ok: false`, error message mentions `OPENCODE_ZEN_API_KEY`; (3) API key set, `OPENCODE_ZEN_MODEL` unset → `ok: false`, error mentions `OPENCODE_ZEN_MODEL`. These must not require Ollama reachability (the opencode-free profile has no Ollama IDs, so preflight is skipped — this also verifies the `ollamaModelIds` filter excludes the Zen token).

### Step 3: Test the profile registration

In `ai-system/config/model-profiles.test.ts` (create if absent, matching the existing profile-test style), add: (1) `findProfile("opencode-free")` returns a profile with `name === "opencode-free"`; (2) for every `ModelRole`, `resolveModelForRole(role, OPENCODE_FREE_PROFILE) === "opencode-free"`; (3) `MODEL_PROFILES["opencode-free"]` is defined.

## Phase 6: Documentation

Commit message: docs: document opencode-free profile and OpenCode Zen provider

### Step 1: Update architecture and reference docs

Add the new profile and provider (the FIFTH provider path — OpenCode Zen, OpenAI-compatible) to the docs. In `docs/architecture.md`: add `opencode-free` to the profiles/routing section and describe the OpenCode Zen provider alongside Copilot/Ollama/Anthropic/Bedrock, including the `OPENCODE_ZEN_MODEL` / `OPENCODE_ZEN_API_KEY` env-driven resolution that mirrors Bedrock's ARN pattern. In `docs/agent-reference.md`: add `opencode-free` to any profile table. In `README.md`: add `opencode-free` to the user-facing profile list with its two required env vars and a note that swapping the free model is a one-line `OPENCODE_ZEN_MODEL` change. In `AGENTS.md`: update the Project Overview provider sentence (currently names four providers) to include OpenCode Zen, add the new dispatcher to the `orchestrator/` directory-structure line, and mention the `opencode-free` profile in the `model-profiles.ts` description.
