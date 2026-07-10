import { DAY_KEYS, type DayKey, type Participant } from '../lib/api';

export function selectedDays(p: Participant, prefix: 'req' | 'pur'): DayKey[] {
  return DAY_KEYS.filter((d) => p[`${prefix}_${d}` as keyof Participant]);
}
