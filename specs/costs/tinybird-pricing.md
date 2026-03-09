# Tinybird Pricing Reference

Last updated: 2026-03-06. All prices USD. Pricing model changed Jan 2025 to vCPU-hour based.

## Plans

### Free (Shared Infrastructure)

| Metric           | Allowance         |
| ---------------- | ----------------- |
| Cost             | $0/month          |
| Baseline vCPU    | 0.5               |
| vCPU-hours/month | 300               |
| Auto-scale       | Up to 1 vCPU (2x) |
| Storage          | 10 GB             |
| Queries/day      | 1,000             |
| Max QPS          | 10 (burst to 20)  |
| Support          | Community         |

### Developer Plans (Shared Infrastructure)

| Plan           | Monthly | vCPU | vCPU-hrs/mo | Storage | QPS | Auto-scale |
| -------------- | ------- | ---- | ----------- | ------- | --- | ---------- |
| Developer 0.25 | $25     | 0.25 | 150         | 25 GB   | 10  | 0.5 vCPU   |
| Developer 0.5  | $49     | 0.5  | 300         | 25 GB   | 15  | 1 vCPU     |
| Developer 1    | $99     | 1    | 600         | 25 GB   | 25  | 2 vCPU     |
| Developer 2    | $199    | 2    | 1,200       | 25 GB   | 40  | 4 vCPU     |
| Developer 3    | $299    | 3    | 1,800       | 25 GB   | 55  | 6 vCPU     |

### SaaS & Enterprise

- SaaS: Custom pricing, 4+ vCPUs, 500 GB storage, 80+ QPS
- Enterprise: Dedicated infrastructure, unlimited vCPUs, custom SLA

## Overage Rates

| Metric                 | Rate             |
| ---------------------- | ---------------- |
| vCPU-hours beyond plan | $0.162/vCPU-hour |
| Storage beyond plan    | $0.058/GB-month  |
| Queries beyond QPS     | $0.0005/request  |

## Key Details

- **Ingestion is unlimited** across all plans (no per-event charge)
- Write requests don't count toward QPS limits
- Materialized views consume vCPU time but no extra query charges
- QPS burst: 2x baseline for 1 minute, 5-minute cooldown
- Parameterized pipe endpoints count as standard queries

## Sources

- https://www.tinybird.co/pricing
- https://www.tinybird.co/docs/forward/pricing
- https://www.tinybird.co/docs/forward/pricing/limits
