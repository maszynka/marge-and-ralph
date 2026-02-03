/**
 * Signal protocol for agent ↔ orchestrator communication.
 *
 * Agents emit HTML-comment signals in stdout:
 *   <!-- SIGNAL:TYPE attr="val" -->
 *   optional body
 *   <!-- /SIGNAL -->
 *
 * The orchestrator parses these in real-time from the output stream.
 */

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

export type SignalType =
  | "TASK_COMPLETE"
  | "CHECKPOINT"
  | "BLOCKED"
  | "PLAN_COMPLETE"
  | "PLAN_PROPOSAL"
  | "DISCOVERY_QUESTIONS"
  | "VERIFICATION"
  | "COMPLETE"
  | "ERROR"
  | "ITERATION_ESTIMATE"
  | "OPTIMIZATION_COMPLETE";

export interface Signal {
  type: SignalType;
  attrs: Record<string, string>;
  body: string;
}

export interface TaskCompleteSignal extends Signal {
  type: "TASK_COMPLETE";
  attrs: { task: string; commit?: string; files?: string };
}

export interface CheckpointSignal extends Signal {
  type: "CHECKPOINT";
  attrs: { type: "decision" | "human-verify" | "human-action" };
}

export interface BlockedSignal extends Signal {
  type: "BLOCKED";
  attrs: { reason: string };
}

export interface PlanCompleteSignal extends Signal {
  type: "PLAN_COMPLETE";
  attrs: { plans: string; waves: string };
}

export interface VerificationSignal extends Signal {
  type: "VERIFICATION";
  attrs: { status: "passed" | "gaps_found" | "human_needed"; score: string };
}

export interface CompleteSignal extends Signal {
  type: "COMPLETE";
}

export interface IterationEstimateSignal extends Signal {
  type: "ITERATION_ESTIMATE";
  attrs: {
    suggested: string;
    complexity: string; // "low" | "medium" | "high"
    reasoning?: string;
  };
}

export interface OptimizationCompleteSignal extends Signal {
  type: "OPTIMIZATION_COMPLETE";
  attrs: {
    improvements: string;
    summary?: string;
  };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const SIGNAL_OPEN = /<!--\s*SIGNAL:(\w+)((?:\s+\w+="[^"]*")*)\s*-->/;
const SIGNAL_CLOSE = /<!--\s*\/SIGNAL\s*-->/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

/** Parse attributes from the opening tag remainder. */
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/**
 * Stateful signal parser.  Feed it lines (or chunks) and it will emit
 * complete Signal objects via the callback.
 */
export class SignalParser {
  private pending: { type: SignalType; attrs: Record<string, string> } | null = null;
  private bodyLines: string[] = [];

  /** Feed a single line. Returns a Signal if one completed, else null. */
  feed(line: string): Signal | null {
    // Check for legacy ralph completion signal
    if (line.includes("<promise>COMPLETE</promise>")) {
      return { type: "COMPLETE", attrs: {}, body: "" };
    }

    // Check for closing tag first (before opening, in case same line)
    if (this.pending && SIGNAL_CLOSE.test(line)) {
      const signal: Signal = {
        type: this.pending.type,
        attrs: this.pending.attrs,
        body: this.bodyLines.join("\n").trim(),
      };
      this.pending = null;
      this.bodyLines = [];
      return signal;
    }

    // Check for opening tag
    const open = SIGNAL_OPEN.exec(line);
    if (open) {
      const type = open[1] as SignalType;
      const attrs = parseAttrs(open[2] || "");

      // Self-closing: if close tag on the same line
      if (SIGNAL_CLOSE.test(line)) {
        // Body is everything between open and close on the same line
        const afterOpen = line.slice((open.index ?? 0) + open[0].length);
        const closeIdx = afterOpen.indexOf("<!-- /SIGNAL -->");
        const body = closeIdx >= 0 ? afterOpen.slice(0, closeIdx).trim() : "";
        return { type, attrs, body };
      }

      // Start accumulating body
      this.pending = { type, attrs };
      this.bodyLines = [];
      return null;
    }

    // Accumulate body if inside a signal
    if (this.pending) {
      this.bodyLines.push(line);
    }

    return null;
  }

  /** Reset parser state. */
  reset(): void {
    this.pending = null;
    this.bodyLines = [];
  }
}
