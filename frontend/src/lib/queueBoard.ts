import type { PurchaseQueueEntry } from './api';
import { parseClaimTimestamp } from './purchaseBoard';

/** How long a ▲/▼ marker stays next to a place after its pick number changes. */
export const QUEUE_MOVE_SHOW_MS = 60_000;

export function isQueueActive(q: PurchaseQueueEntry): boolean {
  return q.status !== 'done' && q.status !== 'skipped';
}

/** Places still in line, in the server's order: buying, then soonest due, then join order. */
export function activeQueue(queue: PurchaseQueueEntry[]): PurchaseQueueEntry[] {
  return queue.filter(isQueueActive);
}

/** Milliseconds until this place is due through Queue-It; null when nobody has reported. */
export function etaRemainingMs(entry: PurchaseQueueEntry, now = Date.now()): number | null {
  if (!entry.eta_at) return null;
  const due = parseClaimTimestamp(entry.eta_at);
  return due == null ? null : Math.max(0, due - now);
}

export function formatEtaRemaining(ms: number | null): string {
  if (ms == null) return 'No ETA';
  if (ms === 0) return 'Due now';
  const minutes = Math.ceil(ms / 60000);
  if (minutes >= 60) return `~${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `~${minutes} min`;
}

export function formatDueClock(entry: PurchaseQueueEntry): string | null {
  if (!entry.eta_at) return null;
  const due = parseClaimTimestamp(entry.eta_at);
  if (due == null) return null;
  return new Date(due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** 1-based pick number of each place still in line. */
export function rankById(queue: PurchaseQueueEntry[]): Map<number, number> {
  return new Map(activeQueue(queue).map((q, i) => [q.id, i + 1]));
}

/**
 * How far each place moved between two snapshots of the line. Positive means it moved up.
 * A place that just joined has no previous rank and is left out rather than shown as a jump.
 */
export function rankMovement(
  previous: Map<number, number>,
  current: Map<number, number>,
): Map<number, number> {
  const moves = new Map<number, number>();
  for (const [id, rank] of current) {
    const before = previous.get(id);
    if (before != null && before !== rank) moves.set(id, before - rank);
  }
  return moves;
}
