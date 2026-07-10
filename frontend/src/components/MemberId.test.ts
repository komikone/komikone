import { describe, expect, it } from 'vitest';
import { normalizeMemberIdInput } from '../components/MemberId';

describe('normalizeMemberIdInput', () => {
  it('uppercases letters', () => {
    expect(normalizeMemberIdInput('ab12cd')).toBe('AB12CD');
  });

  it('preserves digits and mixed ids', () => {
    expect(normalizeMemberIdInput('o0i1l')).toBe('O0I1L');
  });
});

/** Mirrors MemberId digit-split rendering logic. */
function splitMemberIdParts(value: string): { text: string; digit: boolean }[] {
  const s = value.trim().toUpperCase();
  return s.split(/(\d+)/).filter(Boolean).map((part) => ({
    text: part,
    digit: /^\d+$/.test(part),
  }));
}

describe('MemberId digit highlighting', () => {
  it('marks digit runs separately from letters', () => {
    expect(splitMemberIdParts('ab01o0')).toEqual([
      { text: 'AB', digit: false },
      { text: '01', digit: true },
      { text: 'O', digit: false },
      { text: '0', digit: true },
    ]);
  });

  it('handles all-digit and empty', () => {
    expect(splitMemberIdParts('12345')).toEqual([{ text: '12345', digit: true }]);
    expect(splitMemberIdParts('')).toEqual([]);
  });
});
