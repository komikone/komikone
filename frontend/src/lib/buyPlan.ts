import type { Participant, PurchaseQueueEntry } from './api';
import { MAX_ACTIVE_CLAIMS } from './purchaseBoard';

export type PlaceSlot = {
  /** null when you have no place in line yet: where your first place's picks would go. */
  place: PurchaseQueueEntry | null;
  /** Already claimed through this place. */
  claimed: Participant[];
  /** Who this place claims next, straight off your list in order. */
  upcoming: Participant[];
  /** Spots this place still has nobody for. */
  open: number;
};

export type BuyPlan = {
  slots: PlaceSlot[];
  /** Still on your list, but past what your places can hold or not buyable right now. */
  rest: Participant[];
  /** Your claims whose place is no longer in line. */
  unplaced: Participant[];
};

/**
 * Splits your buy list across your places in line, 3 per place in line order, so the
 * soonest place always buys your top picks. Whoever a place already claimed stays with it;
 * moving someone up or down the list is how you move them to a different place.
 */
export function planBuyList({ list, myClaims, places, isReady }: {
  /** Your list in order, without the people you've already claimed. */
  list: Participant[];
  myClaims: Participant[];
  /** Your places still in line, soonest first. */
  places: PurchaseQueueEntry[];
  isReady: (p: Participant) => boolean;
}): BuyPlan {
  const placeIds = new Set(places.map((q) => q.id));
  const slots: PlaceSlot[] = (places.length > 0 ? places : [null]).map((place) => {
    const claimed = place ? myClaims.filter((p) => p.purchasing_claimed_queue_id === place.id) : [];
    return { place, claimed, upcoming: [], open: Math.max(0, MAX_ACTIVE_CLAIMS - claimed.length) };
  });
  const unplaced = myClaims.filter(
    (p) => p.purchasing_claimed_queue_id == null || !placeIds.has(p.purchasing_claimed_queue_id),
  );

  const rest: Participant[] = [];
  let k = 0;
  for (const p of list) {
    while (k < slots.length && slots[k].open === 0) k += 1;
    if (k < slots.length && isReady(p)) {
      slots[k].upcoming.push(p);
      slots[k].open -= 1;
    } else {
      rest.push(p);
    }
  }
  return { slots, rest, unplaced };
}
