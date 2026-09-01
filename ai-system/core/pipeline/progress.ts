/*!
 * Progress event model for plan-cycle verbosity.
 *
 * Runners (feature-runner, phase-runner, verified-implement-step) optionally
 * emit `ProgressEvent`s through an `OnProgress` callback as phases and steps
 * execute. When no callback is supplied, no events are constructed and there
 * is zero overhead -- verbosity is strictly opt-in.
 *
 * This module is pure: it only defines the event shapes and a formatter that
 * turns an event into a single human-readable line. It performs no I/O; the
 * CLI decides where formatted lines are written (stderr) and whether ANSI
 * color is used.
 */

import type { RestoreFailedProgressEvent, StructuredPatchReason } from "@ai-coding/shared";

/** A single phase or step lifecycle event emitted during a plan-cycle run. */
export type ProgressEvent =
  | { readonly kind: "phase-start"; readonly phase: number; readonly title: string }
  | {
      readonly kind: "phase-attempt";
      readonly phase: number;
      readonly retry: "local" | "escalation";
      readonly index: number;
      readonly max: number;
    }
  | {
      readonly kind: "phase-finish";
      readonly phase: number;
      readonly commitMessage: string;
      readonly commitHash?: string;
    }
  | { readonly kind: "phase-fail"; readonly phase: number; readonly reason: string }
  | {
      readonly kind: "step-start";
      readonly phase: number;
      readonly step: number;
      readonly title: string;
    }
  | { readonly kind: "step-finish"; readonly phase: number; readonly step: number }
  | {
      readonly kind: "vacuous-pass";
      readonly phase: number;
      readonly reason: string;
    }
  | {
      readonly kind: "step-fail";
      readonly phase: number;
      readonly step: number;
      readonly reason: string;
    }
  | {
      readonly kind: "step-retry";
      readonly phase: number;
      readonly step: number;
      readonly index: number;
      readonly max: number;
      readonly retry: "local" | "escalation";
    }
  | {
      readonly kind: "patch-path";
      readonly phase: number;
      readonly step?: number;
      readonly path: "structured-applied" | "fell-back-to-text" | "structured-aborted";
      readonly reason: StructuredPatchReason;
      /**
       * Optional human-readable diagnostic detail, present only for the
       * `dispatch-error` fell-back-to-text case. Carries the underlying
       * transport failure (derived from the dispatch error's cause) so the
       * progress line can surface it without re-appending it to the reason.
       */
      readonly detail?: string;
    }
  | RestoreFailedProgressEvent;

/** Callback invoked with each `ProgressEvent` as a plan-cycle run progresses. */
export type OnProgress = (event: ProgressEvent) => void;

/** Rendering theme: glyphs plus whether ANSI color codes should be emitted. */
export interface Theme {
  /** Whether ANSI SGR color codes are wrapped around glyphs. */
  readonly useColor: boolean;
  /** Glyph rendered for each event kind. */
  readonly glyphs: Readonly<Record<ProgressEvent["kind"], string>>;
}

/** Nerd-font glyphs used when the output stream supports color/Unicode. */
const NERD_GLYPHS: Readonly<Record<ProgressEvent["kind"], string>> = {
  "phase-start": "▶",
  "phase-attempt": "⟳",
  "phase-finish": "✓",
  "phase-fail": "✖",
  "step-start": "○",
  "step-finish": "✓",
  "step-fail": "✗",
  "step-retry": "↻",
  "patch-path": "⇄",
  "restore-failed": "⚠",
  "vacuous-pass": "⊘",
};

/** ASCII fallback glyphs used when color/Unicode is not appropriate. */
const ASCII_GLYPHS: Readonly<Record<ProgressEvent["kind"], string>> = {
  "phase-start": ">",
  "phase-attempt": "~",
  "phase-finish": "+",
  "phase-fail": "X",
  "step-start": "o",
  "step-finish": "+",
  "step-fail": "x",
  "step-retry": "~",
  "patch-path": "=",
  "restore-failed": "!",
  "vacuous-pass": "0",
};

/** ANSI SGR codes used to color each event kind's glyph. */
const SGR: Readonly<Record<ProgressEvent["kind"], string>> = {
  "phase-start": "\x1b[36m", // cyan
  "phase-attempt": "\x1b[33m", // yellow
  "phase-finish": "\x1b[32m", // green
  "phase-fail": "\x1b[31m", // red
  "step-start": "\x1b[34m", // blue
  "step-finish": "\x1b[32m", // green
  "step-fail": "\x1b[31m", // red
  "step-retry": "\x1b[33m", // yellow
  "patch-path": "\x1b[35m", // magenta
  "restore-failed": "\x1b[31m", // red
  "vacuous-pass": "\x1b[31m", // red
};

const SGR_RESET = "\x1b[0m";

/**
 * Build a rendering theme.
 *
 * @param useColor - When true, glyphs are wrapped in ANSI SGR color codes and
 *   nerd-font glyphs are used. When false, plain ASCII glyphs are used and no
 *   escape codes are emitted.
 */
export function buildTheme(useColor: boolean): Theme {
  return { useColor, glyphs: useColor ? NERD_GLYPHS : ASCII_GLYPHS };
}

/** Color a glyph with its event kind's SGR code, or return it unchanged when color is off. */
function paintGlyph(kind: ProgressEvent["kind"], glyph: string, theme: Theme): string {
  if (!theme.useColor) return glyph;
  return `${SGR[kind]}${glyph}${SGR_RESET}`;
}

/** Build the label text (without glyph or indentation) for a progress event. */
function buildLabel(event: ProgressEvent): string {
  switch (event.kind) {
    case "phase-start":
      return `Phase ${event.phase}  ${event.title}`;
    case "phase-attempt":
      return `Phase ${event.phase}  re-implementing & verifying · ${event.retry} ${event.index}/${event.max}`;
    case "phase-finish":
      return `Phase ${event.phase}  committed: ${event.commitMessage}`;
    case "phase-fail":
      return `Phase ${event.phase}  aborted: ${event.reason}`;
    case "step-start":
      return `Step ${event.step}  ${event.title}`;
    case "step-finish":
      return `Step ${event.step}`;
    case "step-fail":
      return `Step ${event.step}  failed: ${event.reason}`;
    case "step-retry":
      return `Step ${event.step}  ${event.retry} retry ${event.index}/${event.max}`;
    case "restore-failed":
      return `Phase ${event.phase}  working-tree restore FAILED: ${event.reason}`;
    case "vacuous-pass":
      return `Phase ${event.phase}  VACUOUS PASS blocked: ${event.reason}`;
    case "patch-path": {
      const base =
        event.path === "structured-applied"
          ? `Phase ${event.phase}  structured patch applied (${event.reason})`
          : event.path === "structured-aborted"
            ? `Phase ${event.phase}  structured patch ABORTED (${event.reason})`
            : `Phase ${event.phase}  fell back to text loop (${event.reason})`;
      return (event.path === "fell-back-to-text" || event.path === "structured-aborted") &&
        event.detail !== undefined &&
        event.detail.length > 0
        ? `${base}: ${event.detail}`
        : base;
    }
  }
}

/** Whether a progress event is scoped to a step (and thus indented under its phase). */
function isStepEvent(kind: ProgressEvent["kind"]): boolean {
  return (
    kind === "step-start" || kind === "step-finish" || kind === "step-fail" || kind === "step-retry"
  );
}

/**
 * Format a single progress event as one line (no trailing newline).
 *
 * Step-scoped events are indented two spaces under their phase; phase-scoped
 * events are not indented. The event's glyph is colored per `theme` when
 * `theme.useColor` is true.
 *
 * @param event - The progress event to render.
 * @param theme - The rendering theme (glyphs + color on/off).
 */
export function formatProgressEvent(event: ProgressEvent, theme: Theme): string {
  const indent =
    isStepEvent(event.kind) || (event.kind === "patch-path" && event.step !== undefined)
      ? "  "
      : "";
  const glyph = paintGlyph(event.kind, theme.glyphs[event.kind], theme);
  const label = buildLabel(event);
  return `${indent}${glyph} ${label}`;
}
