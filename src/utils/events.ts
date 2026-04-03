type Listener = () => void;
const listeners: Record<string, Set<Listener>> = {};

export function on(event: string, fn: Listener) {
  if (!listeners[event]) listeners[event] = new Set();
  listeners[event].add(fn);
  return () => { listeners[event]?.delete(fn); };
}

export function emit(event: string) {
  listeners[event]?.forEach(fn => fn());
}
