import { SignIn as ClerkSignIn } from '@clerk/clerk-react';
import { useSearchParams } from 'react-router-dom';

export default function SignIn() {
  const [params] = useSearchParams();
  const redirect = params.get('redirect') ?? '/';

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center gap-6 p-4">
      <div className="text-center mb-2">
        <div className="font-bangers text-yellow-400 text-4xl tracking-wide">komikone</div>
        <div className="text-zinc-500 text-sm mt-1">Sign in to access the live board</div>
      </div>
      <ClerkSignIn
        routing="hash"
        forceRedirectUrl={redirect}
        appearance={{
          variables: {
            colorPrimary: '#facc15',
            colorBackground: '#18181b',
            colorText: '#ffffff',
            colorInputBackground: '#27272a',
            colorInputText: '#ffffff',
            borderRadius: '0.5rem',
          },
          elements: {
            card: 'shadow-2xl border border-zinc-700',
            headerTitle: 'font-bangers tracking-wide text-yellow-400',
          },
        }}
      />
    </div>
  );
}
