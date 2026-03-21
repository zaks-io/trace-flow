import { preloadQuery } from 'convex/nextjs';
import { api } from '@convex/_generated/api';
import { getConvexToken } from '@/lib/convex';
import Pricing from '@/components/billing/Pricing';

export default async function PricingPage() {
  const token = await getConvexToken();
  const preloadedPricing = await preloadQuery(api.billing.modelPricing.list, {}, { token });

  return <Pricing preloadedPricing={preloadedPricing} />;
}
