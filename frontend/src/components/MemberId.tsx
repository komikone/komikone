import type { ReactNode } from 'react';

type MemberIdProps = {
  value: string | null | undefined;
  className?: string;
  empty?: ReactNode;
  /** Letter color (default gray suited for dark UIs). */
  letterClassName?: string;
  /** Digit color — distinct so 0/O and 1/I/l are easier to tell apart. */
  digitClassName?: string;
};

/**
 * Displays a Comic-Con Member ID in all caps with digits in a contrasting color
 * so 0 vs O and 1 vs I/l are easier to distinguish.
 */
export function MemberId({
  value,
  className = 'font-mono text-xs tracking-wide',
  empty = '—',
  letterClassName = 'text-gray-700 dark:text-gray-300',
  digitClassName = 'text-amber-600 dark:text-amber-400',
}: MemberIdProps) {
  const s = (value ?? '').trim().toUpperCase();
  if (!s) {
    return (
      <span className={`${className} text-gray-400 dark:text-gray-600`}>
        {empty}
      </span>
    );
  }

  const parts = s.split(/(\d+)/);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        /^\d+$/.test(part) ? (
          <span key={i} className={digitClassName}>{part}</span>
        ) : (
          <span key={i} className={letterClassName}>{part}</span>
        ),
      )}
    </span>
  );
}

/** Normalize Member ID input to uppercase as the user types. */
export function normalizeMemberIdInput(raw: string): string {
  return raw.toUpperCase();
}
