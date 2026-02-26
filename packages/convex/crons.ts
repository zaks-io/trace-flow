import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.weekly(
  'cleanup old stripe events',
  { dayOfWeek: 'sunday', hourUTC: 4, minuteUTC: 0 },
  internal.stripeEvents.cleanupOldEvents,
);

export default crons;
