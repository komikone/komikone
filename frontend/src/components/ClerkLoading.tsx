import { useEffect, useState } from 'react';

const SLOW_MS = 8000;

/**
 * Stand-in for Clerk's sign-in box while Clerk's script loads. The box renders nothing
 * until then, so on a slow phone connection the page looked empty, and only a refresh
 * (which retries the download) got people in. Offers that refresh after a while.
 */
export function ClerkLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="text-center">
      <p className="text-gray-400 text-sm">Loading sign-in…</p>
      {slow && (
        <div className="mt-4">
          <p className="text-gray-500 text-xs mb-2">Taking longer than usual.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Reload
          </button>
        </div>
      )}
    </div>
  );
}
