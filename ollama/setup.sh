#!/usr/bin/env bash
# ollama/setup.sh -- Build derivative Ollama models for the ai-coding project.
#
# PURPOSE
# -------
# Some models require small configuration overrides (e.g., disabling
# chain-of-thought reasoning) that cannot be passed reliably through
# Ollama's OpenAI-compatible /v1/chat/completions endpoint.  Instead
# of patching the AI SDK adapter, we create lightweight derivative
# models that bake the override into a Modelfile.  Ollama uses
# content-addressable layers, so derivatives share the base weights
# and consume negligible extra disk space.
#
# See docs/ollama-models.md for the full design rationale.
#
# USAGE
# -----
#   ./ollama/setup.sh            build all derivative models
#   ./ollama/setup.sh --check    dry-run: print what would be built
#
# IDEMPOTENCY
# -----------
# This script is safe to run multiple times.  `ollama create` updates
# the model in-place if it already exists.  If the base model is not
# yet pulled, that model is skipped with a warning -- rerun after
# pulling the base.
#
# FRESH MACHINE WORKFLOW
# ----------------------
#   1. Install and start Ollama:
#        systemctl --user start ollama   (if managed by systemd)
#        ollama serve &                  (manual)
#   2. Pull base weights:
#        ollama pull qwen3:8b
#   3. Run this script:
#        ~/Projects/ai-coding/ollama/setup.sh
#
# The home-manager activation script (home.activation.ensureOllamaModels)
# calls this script automatically on every `home-manager switch` as long
# as Ollama is installed and running.  So on a machine managed by
# home-manager, step 3 above is handled for you once step 2 is done.
#
# ADDING NEW DERIVATIVE MODELS
# ----------------------------
# 1. Create a Modelfile in this directory (e.g., mymodel.Modelfile).
#    Follow the pattern in qwen3-8b-fast.Modelfile -- include a detailed
#    comment block explaining why the derivative exists.
# 2. Add an entry to the MODELS array below:
#      "output-name  path/to/file.Modelfile"
# 3. Add the model ID to opencode/mappings/opencode.json.
# 4. Update docs/ollama-models.md with the new model's description.
# 5. Commit both repos and run `home-manager switch`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# MODELS: space-separated pairs of "output-model-name  /path/to/Modelfile"
# Add one entry per derivative model.
# ---------------------------------------------------------------------------
MODELS=(
  "qwen3:8b-fast  ${SCRIPT_DIR}/qwen3-8b-fast.Modelfile"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf '[setup] %s\n' "$*"; }
warn()  { printf '[setup] WARNING: %s\n' "$*" >&2; }

# Check that ollama is available and reachable; exit 0 (not 1) on failure so
# that the home-manager activation script does not abort the full switch.
check_ollama() {
  if ! command -v ollama &>/dev/null; then
    warn "ollama not found in PATH -- skipping model setup"
    exit 0
  fi
  # `ollama list` contacts the running daemon; non-zero means daemon is down.
  if ! ollama list &>/dev/null 2>&1; then
    warn "ollama daemon not reachable -- skipping model setup"
    warn "Start it with: ollama serve   or   systemctl --user start ollama"
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
check_ollama

DRY_RUN=false
if [[ "${1:-}" == "--check" ]]; then
  DRY_RUN=true
  info "dry-run mode -- no models will be created"
fi

for entry in "${MODELS[@]}"; do
  # Split on whitespace
  read -r name modelfile <<< "$entry"

  # Derive the base model name from the FROM directive in the Modelfile.
  base=$(grep -i '^FROM ' "$modelfile" | head -1 | awk '{print $2}')

  # Check that the base model has been pulled.
  if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$base"; then
    warn "base model '${base}' not found in 'ollama list'"
    warn "Pull it first:  ollama pull ${base}"
    warn "Skipping '${name}'"
    continue
  fi

  if $DRY_RUN; then
    info "[dry-run] would run: ollama create ${name} -f ${modelfile}"
  else
    info "Creating '${name}' from '${modelfile}' ..."
    ollama create "$name" -f "$modelfile"
    info "'${name}' ready"
  fi
done

info "Done."
