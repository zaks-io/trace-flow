# Third-Party Services Pricing Reference

Last updated: 2026-03-06. All prices USD.

## Auth0

| Plan             | Monthly Cost   | MAUs   | Notes                    |
| ---------------- | -------------- | ------ | ------------------------ |
| Free             | $0             | 25,000 | Custom domains supported |
| B2C Essentials   | $35            | 500    |                          |
| B2C Professional | $240           | 1,000  |                          |
| B2B Essentials   | $150           | 500    |                          |
| B2B Professional | Custom         | Custom |                          |
| Enterprise       | Custom (>$10K) | Custom | 99.99% SLA               |

Custom domains (auth0.zaks.io) are available on the free plan.

## Stripe

### Processing Fees

| Method                         | Rate                           |
| ------------------------------ | ------------------------------ |
| Online cards + digital wallets | 2.9% + $0.30/txn               |
| Manually entered cards         | 3.4% + $0.30/txn               |
| International cards            | 3.9% + $0.30 + 1% cross-border |
| ACH payments                   | 0.8% (capped at $5)            |
| Chargebacks                    | $15 each                       |

### Additional Products

| Product           | Fee                                      |
| ----------------- | ---------------------------------------- |
| Stripe Tax        | 0.5% per transaction (0.4% at >$100K/mo) |
| Stripe Billing    | No additional fee                        |
| Customer Portal   | No additional fee                        |
| Checkout Sessions | No additional fee                        |

Volume discounts available at $50K+/month (as low as 2.4% + $0.30).

## Sentry

| Plan             | Monthly Cost | Error Events  | Overage         |
| ---------------- | ------------ | ------------- | --------------- |
| Developer (Free) | $0           | 5,000/month   | N/A             |
| Team             | $26          | 50,000/month  | $0.000290/event |
| Business         | $89          | 100,000/month | $0.000290/event |
| Enterprise       | Custom       | Custom        | Negotiated      |

## GitHub Actions

### Free Minutes (Private Repos)

| GitHub Plan | Minutes/Month |
| ----------- | ------------- |
| Personal    | 2,000         |
| Pro         | 3,000         |
| Team        | 3,000         |
| Enterprise  | 50,000        |

Cloud platform charge (effective Jan 2026): $0.002/minute on all runners.
Public repos: Always free.

## Domain

- trace-flow.dev: ~$12-15/year (~$1/month)

## Sources

- https://auth0.com/pricing
- https://stripe.com/pricing
- https://stripe.com/tax/pricing
- https://sentry.io/pricing/
- https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions
