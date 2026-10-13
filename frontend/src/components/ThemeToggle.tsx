import { useTheme, type ThemePreference } from '../lib/useTheme';

const LABELS: Record<ThemePreference, { icon: string; label: string; next: string }> = {
  system: { icon: '◐', label: 'Auto', next: 'Switch to day mode' },
  light: { icon: '☀', label: 'Day', next: 'Switch to night mode' },
  dark: { icon: '◑', label: 'Night', next: 'Match your device setting' },
};

/** Cycles Auto (follow the device) → Day → Night, showing the current choice. */
export function ThemeToggle({ className, compact = false }: { className: string; compact?: boolean }) {
  const { preference, toggle } = useTheme();
  const { icon, label, next } = LABELS[preference];

  return (
    <button type="button" onClick={toggle} className={className} aria-label={next} title={next}>
      {icon}
      <span className={compact ? 'hidden sm:inline' : undefined}> {label}</span>
    </button>
  );
}
