import { describe, expect, it } from 'vitest';
import type { PurchaseQueueEntry } from './api';
import { activeQueue, etaRemainingMs, formatEtaRemaining, rankById, rankMovement } from './queueBoard';

function entry(over: Partial<PurchaseQueueEntry>): PurchaseQueueEntry {
  return {
    id: 1, event_id: 1, participant_id: 1, clerk_user_id: 'user_tony', position: 1,
    status: 'waiting', eta_minutes: null, eta_at: null, label: 'Place 1',
    joined_at: '', updated_at: '', first_name: 'Tony', last_name: 'Nguyen',
    member_id: 'TONY1', group_name: null,
    ...over,
  };
}

describe('queue board', () => {
  it('ranks only places still in line', () => {
    const queue = [
      entry({ id: 1 }),
      entry({ id: 2, status: 'done' }),
      entry({ id: 3, status: 'skipped' }),
      entry({ id: 4 }),
    ];
    expect(activeQueue(queue).map((q) => q.id)).toEqual([1, 4]);
    expect([...rankById(queue)]).toEqual([[1, 1], [4, 2]]);
  });

  it('reports movement up as positive and ignores places that just joined', () => {
    const before = new Map([[1, 1], [2, 2], [3, 3]]);
    const after = new Map([[3, 1], [1, 2], [2, 3], [9, 4]]);
    expect([...rankMovement(before, after)]).toEqual([[3, 2], [1, -1], [2, -1]]);
  });

  it('counts down from the due time instead of repeating the reported minutes', () => {
    const now = Date.parse('2026-10-17T16:00:00Z');
    const due = entry({ eta_minutes: 30, eta_at: '2026-10-17 16:10:00' });
    expect(etaRemainingMs(due, now)).toBe(10 * 60000);
    expect(formatEtaRemaining(etaRemainingMs(due, now))).toBe('~10 min');
  });

  it('says due now rather than going negative once the time passes', () => {
    const now = Date.parse('2026-10-17T16:30:00Z');
    expect(formatEtaRemaining(etaRemainingMs(entry({ eta_at: '2026-10-17 16:10:00' }), now))).toBe('Due now');
    expect(formatEtaRemaining(etaRemainingMs(entry({}), now))).toBe('No ETA');
  });
});
