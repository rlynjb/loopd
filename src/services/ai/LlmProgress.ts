// Live-progress event surfaced through every chain LLM call's optional
// onProgress callback. Mirrors dryrun's data class
// (../dryrun/app/src/main/java/com/dryrun/app/ai/LlmProgress.kt) so the
// UI-side patterns transfer cleanly.
//
// On-device emits done=false updates with a climbing outputTokens estimate
// as the model streams, then a final done=true update with the exact
// counts.
//
// Cloud is a single POST, so it emits one done=true update at the end
// with estimated=true (no per-call usage parsing in this implementation;
// follow-up commit could expose response.usage from each chain's
// callClaude / callOpenAI if the per-call token count matters in UI).
export type LlmProgress = {
  phase: string;        // human-readable label — chain name in practice
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;  // true while streaming or when exact usage unknown
  done?: boolean;
};

// UI-facing snapshot of an in-flight (or just-finished) LLM call. The
// useLlmProgressTracker hook produces this from a stream of LlmProgress
// events plus a 250ms elapsed-time ticker.
export type LlmLoadState = {
  phase: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  elapsedMs: number;
  done: boolean;
};
