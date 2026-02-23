import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Pricing from '@/components/pages/Pricing';

export default async function PricingPage() {
  const token = await getConvexToken();
  const preloadedPricing = await preloadQuery(api.modelPricing.list, {}, { token });

  return <Pricing preloadedPricing={preloadedPricing} />;
}
