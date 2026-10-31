/**
 * Per-browser settings in localStorage. Storage can be blocked or throw (private windows, blocked
 * site data), so every read and write is guarded and the page works without it.
 */
const PREFIX = "agent-inception.";

export function pref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

/** Store a setting (null removes it). False when the browser wouldn't keep it. */
export function setPref(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
    return localStorage.getItem(PREFIX + key) === value;
  } catch {
    return false;
  }
}
