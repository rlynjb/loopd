// Debounced push trigger. Any write site can call schedulePush() — the
// timer resets each call, and pushAll() fires once N seconds after the
// last call. See docs/loopd-cloud-sync-spec.md §4.3.
//
// Dynamic-imports the orchestrator to avoid a circular dependency
// (database.ts → schedulePush → orchestrator → tables/*.ts → database.ts).
// The import only resolves on fire, by which time everything else is up.

const PUSH_DEBOUNCE_MS = 5_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let pushing = false;

export function schedulePush(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    fire();
  }, PUSH_DEBOUNCE_MS);
}

async function fire(): Promise<void> {
  if (pushing) {
    // A push is already in flight — re-queue so the latest changes don't
    // get stranded waiting for the in-flight push to finish.
    schedulePush();
    return;
  }
  pushing = true;
  try {
    const { pushAll } = await import('./orchestrator');
    await pushAll();
  } catch (err) {
    console.warn('[loopd sync] debounced push failed:', err instanceof Error ? err.message : err);
  } finally {
    pushing = false;
  }
}
