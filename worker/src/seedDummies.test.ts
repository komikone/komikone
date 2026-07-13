import { describe, expect, it } from 'vitest';
import { DUMMY_MARKER, DUMMY_MEMBER_PREFIX, DUMMY_GROUP_PREFIX } from './seedDummies';

describe('dummy markers', () => {
  it('uses stable tags for cleanup queries', () => {
    expect(DUMMY_MARKER).toBe('[DUMMY]');
    expect(DUMMY_MEMBER_PREFIX).toBe('DUMMY-');
    expect(DUMMY_GROUP_PREFIX).toBe('[DUMMY] ');
  });
});
