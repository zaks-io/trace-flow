import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.weekly(
  'cleanup old stripe events',
  { dayOfWeek: 'sunday', hourUTC: 4, minuteUTC: 0 },
  internal.billing.stripeEvents.cleanupOldEvents,
);

crons.hourly(
  'recover stale cost alert monitors',
  { minuteUTC: 5 },
  internal.costAlerts.recoverStaleMonitors,
);

export default crons;
