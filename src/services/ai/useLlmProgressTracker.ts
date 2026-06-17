// React hook that turns a stream of LlmProgress events into an
// LlmLoadState the UI can render directly. Mirrors dryrun's
// LlmProgressTracker
// (../dryrun/app/src/main/java/com/dryrun/app/ui/common/LlmProgressTracker.kt)
// — same 250ms ticker, same atomic state fold, same finally-settles-done
// contract.
//
// Usage:
//   const { state, track, clear } = useLlmProgressTracker();
//   const result = await track('summarize', onProgress =>
//     summarize(date, onProgress));
//   clear();
//
// state is null when no call is in flight; otherwise an LlmLoadState
// that updates on token events and every 250ms while the call runs.

import { useCallback, useRef, useState } from 'react';
import type { LlmProgress, LlmLoadState } from './LlmProgress';

const initialState = (label: string): LlmLoadState => ({
  phase: label,
  inputTokens: 0,
  outputTokens: 0,
  estimated: false,
  elapsedMs: 0,
  done: false,
});

export type LlmProgressTracker = {
  state: LlmLoadState | null;
  track: <T>(label: string, block: (onProgress: (p: LlmProgress) => void) => Promise<T>) => Promise<T>;
  clear: () => void;
};

export function useLlmProgressTracker(): LlmProgressTracker {
  const [state, setState] = useState<LlmLoadState | null>(null);
  const startRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTicker = () => {
    if (tickerRef.current) {
      clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  };

  const clear = useCallback(() => {
    stopTicker();
    setState(null);
  }, []);

  const track = useCallback(async <T,>(
    label: string,
    block: (onProgress: (p: LlmProgress) => void) => Promise<T>,
  ): Promise<T> => {
    startRef.current = Date.now();
    setState(initialState(label));
    tickerRef.current = setInterval(() => {
      setState(cur => (cur ? { ...cur, elapsedMs: Date.now() - startRef.current } : cur));
    }, 250);

    try {
      return await block((p) => {
        setState(cur => {
          const base = cur ?? initialState(label);
          return {
            phase: p.phase || base.phase,
            inputTokens: p.inputTokens && p.inputTokens > 0 ? p.inputTokens : base.inputTokens,
            outputTokens:
              (p.outputTokens !== undefined && p.outputTokens > 0) || p.done
                ? (p.outputTokens ?? base.outputTokens)
                : base.outputTokens,
            estimated: p.estimated ?? base.estimated,
            elapsedMs: Date.now() - startRef.current,
            done: p.done ?? base.done,
          };
        });
      });
    } finally {
      stopTicker();
      // Always settle to done so a thrown call still ends the loader.
      setState(cur =>
        cur ? { ...cur, elapsedMs: Date.now() - startRef.current, done: true } : cur,
      );
    }
  }, []);

  return { state, track, clear };
}
