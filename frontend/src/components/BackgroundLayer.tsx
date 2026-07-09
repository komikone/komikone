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
            <div className="absolute inset-0 bg-gradient-to-t from-gray-950 via-gray-950/70 to-gray-950/30" />
          )}
        </>
      )}
      <div className="relative z-10">{children}</div>
    </div>
  );
}
