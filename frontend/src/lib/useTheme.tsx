import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

type Theme = 'dark' | 'light';
export type ThemePreference = Theme | 'system';

// index.html reads this key before first paint, so keep the two in sync.
const STORAGE_KEY = 'komikone_theme_pref';
// Choices saved under the old key predate Auto; dropping them puts everyone back on Auto once.
const LEGACY_STORAGE_KEY = 'komikone_theme';
const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const ThemeContext = createContext<{
  theme: Theme;
  preference: ThemePreference;
  toggle: () => void;
  isDark: boolean;
} | null>(null);

function applyTheme(theme: Theme) {
  if (theme === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
}

function readStoredPreference(): ThemePreference {
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

/** Homepage always renders light content; theme toggle only applies inside the app. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const [preference, setPreference] = useState<ThemePreference>(readStoredPreference);
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches);

  useEffect(() => {
    const mq = darkQuery();
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme: Theme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  useEffect(() => {
    if (isHome) document.documentElement.classList.remove('dark');
    else applyTheme(theme);
  }, [isHome, theme]);

  const toggle = () => {
    const next = NEXT_PREFERENCE[preference];
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    setPreference(next);
  };

  return (
    <ThemeContext.Provider value={{ theme, preference, toggle, isDark: theme === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}