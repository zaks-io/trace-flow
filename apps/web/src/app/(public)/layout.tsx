import { ConvexClientProvider } from '@/components/providers/ConvexClientProvider';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <ConvexClientProvider>{children}</ConvexClientProvider>;
}
