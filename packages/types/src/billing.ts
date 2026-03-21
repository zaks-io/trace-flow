export type SubscriptionTier = 'hobby' | 'pro';
export type BillingStatus = 'active' | 'grace' | 'suspended' | 'canceled';

export const TIER_CONFIG = {
  hobby: { monthlyUnits: 25_000, overagePer100kCents: 0 },
  pro: { monthlyUnits: 100_000, overagePer100kCents: 500 },
} as const;

export const UNITS_PER_ADDON = 100_000;

export const RETENTION_DAYS = {
  hobby: 7,
  pro: 30,
} as const;

export interface SubscriptionKVData {
  tier: SubscriptionTier;
  status: BillingStatus;
  monthlyUnits: number;
  addonUnits: number;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  autoOverage?: boolean;
  overageCapCents?: number;
  cancelAtPeriodEnd?: boolean;
}
