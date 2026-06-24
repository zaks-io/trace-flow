# Cost Alert Webhook Delivery

Cost alert webhooks are customer-configured outbound HTTP targets. Treat every URL and custom
header as untrusted input.

## Customer URL Requirements

- Use `https://` endpoints for customer traffic. Public `http://` endpoints are accepted for
  compatibility, but should be limited to non-sensitive testing.
- The hostname must resolve only to public internet-routable IP addresses. Delivery blocks
  loopback, RFC1918, carrier-grade NAT, link-local, documentation, multicast, reserved, and
  cloud metadata address ranges.
- `localhost`, `*.localhost`, and known metadata hostnames are blocked even before DNS lookup.
- Redirects are not followed. If a receiver moved, update the configured webhook URL to the
  final public endpoint.
- URLs must not include embedded credentials. Put shared webhook secrets in the dedicated
  secret field so Trace Flow can sign the JSON body with `X-Trace-Flow-Signature`.

## Custom Headers

Customers may add simple receiver-specific headers such as `X-Webhook-Source`. Do not use
custom headers for credentials that belong in the secret field.

Trace Flow rejects headers that can change routing, identity, framing, proxy behavior, cookies,
or Trace Flow-managed delivery metadata. Examples include `Host`, `Authorization`,
`Proxy-Authorization`, `Cookie`, `Content-Type`, `Content-Length`, forwarding headers,
`Idempotency-Key`, and `X-Trace-Flow-Signature`.

## Operator Notes

- A webhook can start failing later if its DNS changes to an internal or reserved address. This
  is expected and should be treated as a customer endpoint configuration problem.
- Private receivers should use a public webhook ingress, a managed webhook provider, or a
  dedicated egress-controlled delivery service. Do not bypass the SSRF guard for one-off support
  requests.
- Test channel delivery exercises the same URL, DNS, header, and redirect policy as real cost
  alert delivery.
