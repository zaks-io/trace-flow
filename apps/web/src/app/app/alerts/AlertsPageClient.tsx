'use client';

import type { Preloaded } from 'convex/react';
import type { api } from '@convex/_generated/api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import Alerts from '@/components/alerts/Alerts';
import CostAlerts from '@/components/alerts/CostAlerts';

export default function AlertsPageClient({
  preloadedAlerts,
  preloadedCostAlerts,
}: {
  preloadedAlerts: Preloaded<typeof api.alerts.list>;
  preloadedCostAlerts: Preloaded<typeof api.costAlerts.listForCurrentOrg>;
}) {
  return (
    <div className="animate-fade-in">
      <Tabs defaultValue="trace">
        <TabsList>
          <TabsTrigger value="trace">Trace Alerts</TabsTrigger>
          <TabsTrigger value="cost">Cost Alerts</TabsTrigger>
        </TabsList>

        <TabsContent value="trace" className="mt-4">
          <Alerts preloadedAlerts={preloadedAlerts} />
        </TabsContent>

        <TabsContent value="cost" className="mt-4">
          <CostAlerts preloadedSettings={preloadedCostAlerts} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
