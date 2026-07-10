import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClerk, useUser } from '@clerk/clerk-react';

/** Clerk user avatar + dropdown for dark header bars. */
export function HeaderUserMenu() {
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!isSignedIn || !user) return null;

  const initial = (user.firstName?.[0] ?? user.emailAddresses[0]?.emailAddress[0] ?? '?').toUpperCase();

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center w-8 h-8 rounded-full overflow-hidden border-2 border-white/20 hover:border-yellow-400 transition-colors focus:outline-none"
        aria-label="Account menu"
        aria-expanded={open}
      >
        {user.imageUrl ? (
          <img src={user.imageUrl} alt={user.fullName ?? ''} className="w-full h-full object-cover" />
        ) : (
          <span className="bg-zinc-700 w-full h-full flex items-center justify-center text-white text-xs font-bold">
            {initial}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-10 w-48 bg-zinc-900 border border-zinc-700 shadow-xl z-50">
          <div className="px-3 py-2 border-b border-zinc-700">
            <p className="text-white text-xs font-medium truncate">{user.fullName ?? user.firstName}</p>
            <p className="text-zinc-400 text-xs truncate">{user.emailAddresses[0]?.emailAddress}</p>
          </div>
          {user.publicMetadata?.role === 'admin' && (
            <Link
              to="/admin"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              Admin
            </Link>
          )}
          <Link
            to="/dashboard"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            Dashboard
          </Link>
          <button
            type="button"
            onClick={() => signOut({ redirectUrl: '/' })}
            className="w-full text-left px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
