type ToggleSwitchProps = {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  /** Compact row for tables / dense forms. Default fills available width. */
  layout?: 'row' | 'stack';
  className?: string;
};

/**
 * Shared boolean control for fields like Return Eligible.
 * Prefer this over checkboxes for the same semantic field across the app.
 */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  layout = 'row',
  className = '',
}: ToggleSwitchProps) {
  return (
    <label
      className={`flex cursor-pointer select-none ${
        layout === 'row'
          ? 'items-center justify-between gap-4'
          : 'flex-col items-start gap-2'
      } ${className}`}
    >
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
          checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </label>
  );
}
