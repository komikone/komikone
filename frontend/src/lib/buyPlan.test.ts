import { describe, expect, it } from 'vitest';
import type { Participant, PurchaseQueueEntry } from './api';
import { planBuyList } from './buyPlan';

const person = (id: number, queueId: number | null = null) =>
  ({ id, first_name: `P${id}`, purchasing_claimed_queue_id: queueId }) as Participant;
const place = (id: number) => ({ id, label: `Place ${id}` }) as PurchaseQueueEntry;
const ids = (ps: Participant[]) => ps.map((p) => p.id);
const always = () => true;

describe('planBuyList', () => {
  it('gives each place the next 3 off the list, soonest place first', () => {
    const plan = planBuyList({
      list: [1, 2, 3, 4, 5, 6, 7].map((i) => person(i)),
      myClaims: [],
      places: [place(10), place(11)],
      isReady: always,
    });
    expect(plan.slots.map((s) => ids(s.upcoming))).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(ids(plan.rest)).toEqual([7]);
    expect(plan.slots.map((s) => s.open)).toEqual([0, 0]);
  });

  it("counts a place's existing claims against its 3", () => {
    const plan = planBuyList({
      list: [1, 2, 3].map((i) => person(i)),
      myClaims: [person(20, 10), person(21, 10)],
      places: [place(10), place(11)],
      isReady: always,
    });
    expect(ids(plan.slots[0].claimed)).toEqual([20, 21]);
    expect(ids(plan.slots[0].upcoming)).toEqual([1]);
    expect(ids(plan.slots[1].upcoming)).toEqual([2, 3]);
    expect(plan.slots[1].open).toBe(1);
  });

  it('counts people a place already bought for against its 3', () => {
    const plan = planBuyList({
      list: [1, 2].map((i) => person(i)),
      myClaims: [person(20, 10)],
      bought: [person(30, 10), person(31, 10)],
      places: [place(10), place(11)],
      isReady: always,
    });
    expect(ids(plan.slots[0].bought)).toEqual([30, 31]);
    expect(plan.slots[0].upcoming).toEqual([]);
    expect(ids(plan.slots[1].upcoming)).toEqual([1, 2]);
  });

  it('skips people who cannot be bought right now without using a spot', () => {
    const plan = planBuyList({
      list: [1, 2, 3, 4].map((i) => person(i)),
      myClaims: [],
      places: [place(10)],
      isReady: (p) => p.id !== 2,
    });
    expect(ids(plan.slots[0].upcoming)).toEqual([1, 3, 4]);
    expect(ids(plan.rest)).toEqual([2]);
  });

  it('plans a first place of 3 when you are not in line yet', () => {
    const plan = planBuyList({ list: [person(1)], myClaims: [], places: [], isReady: always });
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0].place).toBeNull();
    expect(plan.slots[0].open).toBe(2);
  });

  it('keeps claims whose place left the line separate', () => {
    const plan = planBuyList({
      list: [],
      myClaims: [person(20, 99), person(21, null), person(22, 10)],
      places: [place(10)],
      isReady: always,
    });
    expect(ids(plan.unplaced)).toEqual([20, 21]);
    expect(ids(plan.slots[0].claimed)).toEqual([22]);
  });
});
