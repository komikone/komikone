/**
 * The invite someone opened but hasn't finished, so a sign-up that lands them somewhere
 * else (e.g. the dashboard) can still send them back to finish joining.
 */
const KEY = 'komikone.pendingInvite';

export function rememberPendingInvite(code: string): void {
  try { localStorage.setItem(KEY, code); } catch { /* storage unavailable */ }
}

export function pendingInvite(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function forgetPendingInvite(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
