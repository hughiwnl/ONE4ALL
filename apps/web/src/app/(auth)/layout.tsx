import { Repeat2 } from 'lucide-react';
import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-6 flex items-center gap-2">
        <Repeat2 className="size-7 text-brand-600" aria-hidden="true" />
        <span className="text-2xl font-semibold tracking-tight">Repeat</span>
      </div>
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-xs">
        {children}
      </div>
    </div>
  );
}
