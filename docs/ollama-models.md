# Ollama Models

This document describes the Ollama models used by this project, why derivative
models exist, how to set them up on a fresh machine, and how to add new ones.

---

## Background: Why Derivative Models?

Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) does not faithfully
forward all Ollama-native request parameters.  In particular, the `think` field
-- which controls Qwen3's chain-of-thought reasoning mode -- is **silently
ignored** by the `/v1` layer.

The AI SDK adapter used by OpenCode (`@ai-sdk/openai-compatible`) correctly
serialises `think: false` into the HTTP request body, but Ollama discards it
before it reaches the model.  Only Ollama's native `/api/chat` endpoint honours
the parameter.

Switching to the native endpoint requires either:

- The `ollama-ai-provider` community package -- which has a hardcoded settings
  list that does not include `think`, so `think: false` would still be ignored.
- A fork of that package to add `think` support.

Rather than maintaining a patched dependency, we create **lightweight derivative
models** that bake the desired override directly into the Ollama model template.
Ollama stores models as content-addressable layers, so derivatives share all
weight blobs with their base model.  Only a tiny metadata/template layer is
added -- no disk space is duplicated.

---

## Models

### `qwen3:8b` (base, thinking enabled)

- **Source:** `ollama pull qwen3:8b`
- **Size:** ~5.2 GB
- **Thinking:** enabled by default
- **Use for:** the internal pipeline orchestrator (`ai-system/core/orchestrator/`),
  which calls Ollama's native `/api/chat` endpoint directly and passes
  `think: false` per request.  Also available in OpenCode via `/models` for
  tasks where deliberate reasoning is wanted.

### `qwen3:8b-fast` (derivative, thinking disabled)

- **Source:** `ollama/qwen3-8b-fast.Modelfile`
- **Extra disk:** negligible (template layer only)
- **Thinking:** permanently disabled
- **Use for:** all OpenCode agents (`local`, `debugger`).  Emits tool calls
  immediately without a reasoning preamble, which is critical for reliable
  tool-calling within OpenCode's context budget.

**Why thinking must be disabled for OpenCode agents:**

When OpenCode invokes a model it injects a large base system prompt, the
project's `AGENTS.md`, the agent's own prompt, and the full tool-schema JSON
for every available tool.  With this context already loaded, `qwen3:8b`
frequently exhausts its output-token budget inside the `<think>` block and
never emits the `<tool_call>` XML.  Disabling thinking eliminates the
reasoning preamble entirely, so the model proceeds straight to the action.

**How the template override works:**

The upstream `qwen3:8b` chat template controls thinking via two mechanisms:

1. Appends `/no_think` to the last user message (when `IsThinkSet=true,
   Think=false` in the API request).
2. Pre-fills the assistant response with an empty `<think>\n\n</think>\n\n`
   block (same condition), which forces the model past the thinking phase.

`qwen3:8b-fast` copies the full upstream template but removes the conditional
guards, making both mechanisms unconditional.  The result is identical to
calling the native `/api/chat` endpoint with `think: false` on every request,
but it works through any API surface including the OpenAI-compatible `/v1`
endpoint.

---

## Setup on a Fresh Machine

### Prerequisites

- Ollama installed and running (`ollama serve` or a systemd service).
- The `ai-coding` repo cloned to `~/Projects/ai-coding`.

### Steps

```bash
# 1. Pull the base weights (~5 GB, one-time download)
ollama pull qwen3:8b

# 2. Build all derivative models
~/Projects/ai-coding/ollama/setup.sh
```

That's it.  Step 2 is also performed automatically by the home-manager
activation script (see below), so on a home-manager-managed machine you only
need to do step 1 manually.

### Verifying the setup

```bash
# Should list both qwen3:8b and qwen3:8b-fast
ollama list

# Quick sanity check -- should return a clean response with no reasoning text
curl -s http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3:8b-fast","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
msg = d['choices'][0]['message']
print('reasoning:', repr(msg.get('reasoning', '')))
print('content:  ', repr(msg.get('content', '')))
"
# Expected: reasoning: ''   content: 'Hi! ...'
```

---

## Home Manager Activation Script

`~/Projects/home-manager/home.nix` contains an activation block:

```nix
home.activation.ensureOllamaModels = lib.hm.dag.entryAfter [ "cloneAiCoding" ] ''
  SETUP="$HOME/Projects/ai-coding/ollama/setup.sh"
  if [ -x "$SETUP" ]; then
    $DRY_RUN_CMD "$SETUP"
  fi
'';
```

This runs `ollama/setup.sh` on every `home-manager switch`.  The script is
guarded: if Ollama is not installed or the daemon is not running, it exits
cleanly with a warning rather than aborting the switch.

On a completely fresh machine the sequence is:

1. `home-manager switch --flake ~/Projects/home-manager#oryp6`
   - Clones the `ai-coding` repo (via `cloneAiCoding` activation).
   - Runs `ollama/setup.sh` -- which exits with a warning if `qwen3:8b`
     has not been pulled yet.
2. `ollama pull qwen3:8b`
3. `home-manager switch --flake ~/Projects/home-manager#oryp6` again
   - This time `setup.sh` finds the base model and builds `qwen3:8b-fast`.

---

## Adding a New Derivative Model

1. **Create the Modelfile** in `ollama/`:

   ```dockerfile
   # mymodel -- one-line description
   #
   # WHY THIS EXISTS
   # ---------------
   # Explain the problem this derivative solves and why the Modelfile
   # approach was chosen over alternatives.
   #
   # HOW TO REBUILD
   #   ollama create mymodel -f ollama/mymodel.Modelfile
   # or: ./ollama/setup.sh

   FROM <base-model>
   # ... overrides ...
   ```

2. **Register it in `ollama/setup.sh`** -- add one line to the `MODELS` array:

   ```bash
   MODELS=(
     "qwen3:8b-fast  ${SCRIPT_DIR}/qwen3-8b-fast.Modelfile"
     "mymodel        ${SCRIPT_DIR}/mymodel.Modelfile"   # <-- add here
   )
   ```

3. **Declare it in `opencode/mappings/opencode.json`** under `provider.ollama.models`.

4. **Update this file** (`docs/ollama-models.md`) with the new model's description.

5. **Commit both repos** (`ai-coding` and `home-manager` if agents change),
   push, and run `home-manager switch`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `qwen3:8b-fast` not in `ollama list` | Model never built | Run `./ollama/setup.sh` |
| `setup.sh` exits with "base model not found" | `qwen3:8b` not pulled | `ollama pull qwen3:8b` |
| `setup.sh` exits with "daemon not reachable" | Ollama not running | `ollama serve` or `systemctl --user start ollama` |
| Agent still produces thinking text | OpenCode using wrong model | Check agent frontmatter (`model: ollama/qwen3:8b-fast`) and `opencode.json` default |
| `ollama create` fails with "unknown parameter" | Tried `PARAMETER think false` | Not valid -- use the TEMPLATE override approach (see Modelfile) |
