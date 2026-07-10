import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'komikone_theme';

const ThemeContext = createContext<{
  theme: Theme;
  toggle: () => void;
  isDark: boolean;
} | null>(null);

function applyTheme(theme: Theme) {
  if (theme === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
}

function readStoredTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'light';
}

/** Homepage always renders light content; theme toggle only applies inside the app. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    if (isHome) document.documentElement.classList.remove('dark');
    else applyTheme(theme);
  }, [isHome, theme]);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    setTheme(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggle, isDark: theme === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
