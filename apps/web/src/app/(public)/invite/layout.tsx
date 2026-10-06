import { ConvexClientProvider } from '@/components/providers/ConvexClientProvider';

export default function InviteLayout({ children }: { children: React.ReactNode }) {
  return <ConvexClientProvider>{children}</ConvexClientProvider>;
}
