import { useEffect, useState } from 'react';
import { api } from './api';

/** Used when no admin URLs are configured yet. */
export const FALLBACK_BACKGROUNDS = [
  'https://images.unsplash.com/photo-1635805737707-575885ab0b74?w=1920&q=80',
  'https://images.unsplash.com/photo-1608889476561-6242cfdbf622?w=1920&q=80',
  'https://images.unsplash.com/photo-1612036789815-37j937d6f34e?w=1920&q=80',
];

let cache: string[] | null = null;
let fetchPromise: Promise<string[]> | null = null;

export function invalidateBackgroundCache() {
  cache = null;
  fetchPromise = null;
}

export async function fetchBackgroundUrls(): Promise<string[]> {
  if (cache) return cache;
  if (!fetchPromise) {
    fetchPromise = api.backgrounds.list()
      .then((res) => {
        cache = res.urls.length > 0 ? res.urls : FALLBACK_BACKGROUNDS;
        return cache;
      })
      .catch(() => {
        cache = FALLBACK_BACKGROUNDS;
        return cache;
      });
  }
  return fetchPromise;
}

export function pickBackgroundUrl(urls: string[]): string {
  if (urls.length === 0) return FALLBACK_BACKGROUNDS[0];
  return urls[Math.floor(Math.random() * urls.length)];
}

/** Picks a random background URL once on mount (from admin list or fallbacks). */
export function useBackgroundImage(): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBackgroundUrls().then((urls) => {
      if (!cancelled) setUrl(pickBackgroundUrl(urls));
    });
    return () => { cancelled = true; };
  }, []);

  return url;
}
