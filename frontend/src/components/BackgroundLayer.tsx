import type { ReactNode } from 'react';
import { useBackgroundImage } from '../lib/useBackgrounds';

type Props = {
  children: ReactNode;
  className?: string;
  overlay?: boolean;
  minHeight?: string;
};

/** Full-bleed photo background with optional dark gradient overlay. */
export default function BackgroundLayer({
  children, className = '', overlay = true, minHeight = 'min-h-full',
}: Props) {
  const url = useBackgroundImage();

  return (
    <div className={`relative ${minHeight} ${className}`}>
      {url && (
        <>
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${url})` }}
          />
          {overlay && (
            <div className="absolute inset-0 bg-gradient-to-t from-white/90 via-white/60 to-white/20 dark:from-gray-950 dark:via-gray-950/70 dark:to-gray-950/30" />
          )}
        </>
      )}
      <div className="relative z-10">{children}</div>
    </div>
  );
}
