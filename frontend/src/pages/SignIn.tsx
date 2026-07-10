import { SignIn as ClerkSignIn } from '@clerk/clerk-react';
import { useSearchParams } from 'react-router-dom';
import { AppPage } from '../components/AppPage';
import { useTheme } from '../lib/useTheme';

const LIGHT_APPEARANCE = {
  variables: {
    colorPrimary: '#facc15',
    colorBackground: '#ffffff',
    colorText: '#111827',
    colorInputBackground: '#f9fafb',
    colorInputText: '#111827',
    borderRadius: '0.5rem',
  },
  elements: {
    card: 'shadow-2xl border border-gray-200',
    header: 'hidden',
    socialButtonsBlockButton: 'bg-gray-100 border border-gray-300 hover:bg-gray-200',
    socialButtonsBlockButtonText: 'text-gray-900 font-medium',
    dividerLine: 'bg-gray-200',
    dividerText: 'text-gray-500',
  },
} as const;

const DARK_APPEARANCE = {
  variables: {
    colorPrimary: '#facc15',
    colorBackground: '#18181b',
    colorText: '#f4f4f5',
    colorInputBackground: '#27272a',
    colorInputText: '#f4f4f5',
    borderRadius: '0.5rem',
  },
  elements: {
    card: 'shadow-2xl border border-gray-700',
    header: 'hidden',
    socialButtonsBlockButton: 'bg-gray-800 border border-gray-600 hover:bg-gray-700',
    socialButtonsBlockButtonText: 'text-white font-medium',
    dividerLine: 'bg-gray-700',
    dividerText: 'text-gray-400',
  },
} as const;

export default function SignIn() {
  const [params] = useSearchParams();
  const redirect = params.get('redirect') ?? '/dashboard';
  const { isDark } = useTheme();

  return (
    <AppPage title="Sign in" backTo={{ to: '/', label: '← Home' }}>
      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-4">
        <div className="text-center mb-2">
          <p className="text-gray-500 dark:text-gray-400 text-sm">Sign in to access your dashboard</p>
        </div>
        <ClerkSignIn
          routing="hash"
          forceRedirectUrl={redirect}
          appearance={isDark ? DARK_APPEARANCE : LIGHT_APPEARANCE}
        />
      </div>
    </AppPage>
  );
}
