import { Link } from 'react-router-dom';
import { useTheme } from '../lib/useTheme';
import { HeaderUserMenu } from './HeaderUserMenu';

type Props = {
  title?: string;
  backTo?: { to: string; label: string };
  children?: React.ReactNode;
};

/** Dark top bar for in-app pages — home link, optional back nav, theme toggle. */
export function AppHeader({ title, backTo, children }: Props) {
  const { toggle, isDark } = useTheme();

  return (
    <header className="shrink-0 bg-black/90 backdrop-blur-sm border-b-2 border-white/10 px-4 sm:px-6 py-2.5 flex items-center gap-3 sm:gap-4 z-30">
      <Link to="/" className="font-bangers text-xl text-white tracking-wide shrink-0 hover:text-yellow-400 transition-colors">
        komikone
      </Link>
      {backTo && (
        <>
          <span className="text-white/20 hidden sm:inline">·</span>
          <Link
            to={backTo.to}
            className="text-xs text-gray-400 hover:text-yellow-400 transition-colors shrink-0 hidden sm:inline"
          >
            {backTo.label}
          </Link>
        </>
      )}
      {title && (
        <span className="text-white/70 text-sm truncate min-w-0 flex-1 hidden md:inline">
          {title}
        </span>
      )}
      {children}
      <div className="ml-auto flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={toggle}
          className="text-xs text-gray-400 hover:text-yellow-400 border border-white/20 px-2 py-0.5 rounded transition-colors"
        >
          {isDark ? '☀ Day' : '◑ Night'}
        </button>
        <HeaderUserMenu />
      </div>
    </header>
  );
}
