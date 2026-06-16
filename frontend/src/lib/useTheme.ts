import { useState } from 'react';

type Theme = 'dark' | 'light';

function applyTheme(theme: Theme) {
  if (theme === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = (localStorage.getItem('komikone_theme') as Theme) ?? 'dark';
    applyTheme(saved);
    return saved;
  });

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('komikone_theme', next);
    applyTheme(next);
    setTheme(next);
  };

  return { theme, toggle, isDark: theme === 'dark' };
}
