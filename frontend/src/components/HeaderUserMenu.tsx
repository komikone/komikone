import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClerk, useUser } from '@clerk/clerk-react';
import { MemberId } from './MemberId';

/** Live Board row the signed-in user is linked to, shown inside the account menu. */
export type BoardIdentity = {
  displayName: string;
  memberId?: string | null;
  groupName?: string | null;
  groupColor?: string | null;
  onChange: () => void;
};

/** Clerk user avatar + dropdown for dark header bars. */
export function HeaderUserMenu({ boardIdentity }: { boardIdentity?: BoardIdentity } = {}) {
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
        className={`flex items-center justify-center w-8 h-8 rounded-full overflow-hidden border-2 transition-colors focus:outline-none ${
          boardIdentity ? 'border-yellow-400 hover:border-yellow-300' : 'border-white/20 hover:border-yellow-400'
        }`}
        aria-label="Account menu"
        aria-expanded={open}
        title={boardIdentity ? `On the board as ${boardIdentity.displayName}` : undefined}
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
        <div className="absolute right-0 top-10 w-56 bg-zinc-900 border border-zinc-700 shadow-xl z-50">
          <div className="px-3 py-2 border-b border-zinc-700">
            <p className="text-white text-xs font-medium truncate">{user.fullName ?? user.firstName}</p>
            <p className="text-zinc-400 text-xs truncate">{user.emailAddresses[0]?.emailAddress}</p>
          </div>
          {boardIdentity && (
            <div className="px-3 py-2 border-b border-zinc-700">
              <p className="text-[10px] uppercase tracking-wider text-yellow-400/80">On the board as</p>
              <p className="text-white text-sm font-semibold truncate mt-0.5">{boardIdentity.displayName}</p>
              {boardIdentity.memberId && (
                <MemberId
                  value={boardIdentity.memberId}
                  className="font-mono text-xs tracking-wide"
                  letterClassName="text-zinc-400"
                  digitClassName="text-amber-400"
                />
              )}
              {boardIdentity.groupName && (
                <div className="mt-1.5">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-medium text-white"
                    style={{ backgroundColor: boardIdentity.groupColor ?? '#6366f1' }}
                  >
                    {boardIdentity.groupName}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => { setOpen(false); boardIdentity.onChange(); }}
                className="mt-2 text-xs text-zinc-400 hover:text-white underline block"
              >
                Change identity
              </button>
            </div>
          )}
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
