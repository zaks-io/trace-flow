import { ConvexClientProvider } from '@/components/providers/ConvexClientProvider';

export default function WaitlistLayout({ children }: { children: React.ReactNode }) {
  return <ConvexClientProvider>{children}</ConvexClientProvider>;
}
