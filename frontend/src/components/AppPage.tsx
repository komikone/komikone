import type { ReactNode } from 'react';
import { AppHeader } from './AppHeader';

type Props = {
  title?: string;
  backTo?: { to: string; label: string };
  children: ReactNode;
  className?: string;
};

/** Standard in-app page shell: dark header + theme-aware body. */
export function AppPage({ title, backTo, children, className = '' }: Props) {
  return (
    <div className={`min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-white flex flex-col ${className}`}>
      <AppHeader title={title} backTo={backTo} />
      {children}
    </div>
  );
}
