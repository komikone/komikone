import { DAY_KEYS, dayLabel } from '../lib/api';

export type DayFlags = Partial<Record<`req_${(typeof DAY_KEYS)[number]}`, boolean>>;

const MAIN_DAYS = ['thu', 'fri', 'sat', 'sun'] as const;

export function DayPicker({
  value, onChange, disabled,
}: {
  value: DayFlags;
  onChange: (next: DayFlags) => void;
  disabled?: boolean;
}) {
  const allMainDays = MAIN_DAYS.every((d) => value[`req_${d}`]);

  /**
   * Comic-Con will not sell Preview Night on its own, so the box stays locked until all
   * four main days are picked, and dropping one of those takes Preview back off rather
   * than leaving a combination the server would reject on save.
   */
  const toggle = (day: string, checked: boolean): DayFlags => {
    const next = { ...value, [`req_${day}`]: checked };
    if (day !== 'preview' && !checked) next.req_preview = false;
    return next;
  };

  return (
    <>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {DAY_KEYS.map((day) => {
          const locked = disabled || (day === 'preview' && !allMainDays);
          return (
            <label
              key={day}
              className={`flex items-center gap-2 select-none text-sm ${locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
              title={day === 'preview' && !allMainDays ? 'Requires Thu, Fri, Sat and Sun' : undefined}
            >
              <input
                type="checkbox"
                disabled={locked}
                checked={!!value[`req_${day}`]}
                onChange={(e) => onChange(toggle(day, e.target.checked))}
                className="w-4 h-4 rounded border-gray-300 bg-gray-100 accent-blue-500"
              />
              <span className="text-gray-700 dark:text-gray-300">{dayLabel(day)}</span>
            </label>
          );
        })}
      </div>
      {!allMainDays && !disabled && (
        <p className="text-gray-500 text-xs mt-1.5">
          Preview Night is only sold with all four main days.
        </p>
      )}
    </>
  );
}
