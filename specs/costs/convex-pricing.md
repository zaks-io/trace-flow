# Convex Pricing Reference

Last updated: 2026-03-06. All prices USD.

## Plans

### Free/Starter - $0/month

| Metric           | Included          | Overage        |
| ---------------- | ----------------- | -------------- |
| Function calls   | 1M/month          | $2.20/M        |
| Database storage | 0.5 GB            | $0.22/GB-month |
| File storage     | 1 GB              | $0.03/GB-month |
| DB bandwidth     | 1 GB/month        | $0.22/GB       |
| File bandwidth   | 1 GB/month        | $0.33/GB       |
| Action compute   | 20 GB-hours/month | $0.33/GB-hour  |

### Professional - $25/developer/month

| Metric           | Included           | Overage        |
| ---------------- | ------------------ | -------------- |
| Function calls   | 25M/month          | $2.00/M        |
| Database storage | 50 GB              | $0.20/GB-month |
| File storage     | 100 GB             | $0.03/GB-month |
| DB bandwidth     | 50 GB/month        | $0.20/GB       |
| File bandwidth   | 50 GB/month        | $0.30/GB       |
| Action compute   | 250 GB-hours/month | $0.30/GB-hour  |

### Enterprise - Custom pricing

Advanced telemetry, compliance, SSO, auditing, SLAs.

## Concurrency Limits

| Metric                 | Free (S16) | Pro (S256) | Enterprise (D1024) |
| ---------------------- | ---------- | ---------- | ------------------ |
| Query concurrency      | 16         | 256+       | 1,024              |
| Mutation concurrency   | 16         | 256+       | 512                |
| Action concurrency     | 64         | 256+       | 2,048              |
| Query/mutation timeout | 1s         | 1s         | 1s                 |
| Action timeout         | 10 min     | 10 min     | 10 min             |

## Key Details

- Scheduled functions count as regular function calls
- Action compute measures memory-time (GB-hours)
- JWT signing and short HTTP calls are negligible compute
- EU hosting adds 30% surcharge to all pricing

## Sources

- https://www.convex.dev/pricing
- https://docs.convex.dev/production/state/limits
