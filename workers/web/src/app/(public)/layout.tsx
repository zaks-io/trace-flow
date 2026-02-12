import { ConvexClientProvider } from '@/components/ConvexClientProvider';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <ConvexClientProvider>{children}</ConvexClientProvider>;
}
