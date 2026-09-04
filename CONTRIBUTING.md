# Contributing

Trace Flow is primarily internal tooling for Zaks.io. We share the code as it evolves for our own
use. We cannot promise review times, acceptance of contributions, or long-term API compatibility.

For a substantial change, open an issue describing the problem before building it. Small bug fixes
and corrections to documentation can go straight to a pull request. Include the reproduction,
what changed, and the checks you ran. Keep changes focused.

Read [README.md](./README.md), [SETUP.md](./SETUP.md), and [AGENTS.md](./AGENTS.md) for the repository
layout, environment setup, and code conventions. Some maintainer workflows reference private
trackers and company infrastructure; outside contributors do not need access to those systems.
Use GitHub issues and your own development resources.

Run the checks relevant to your change. The workspace commands are in `package.json`; Rust checks
use `cargo test --workspace --locked`. Follow the setup guide before running integration checks.
A passing unit test does not establish that a hosted integration works. State what you could not
verify. Do not point tests or deployment commands at the company production environment.

Use synthetic fixtures. Never submit credentials, real conversations, customer data, local database
copies, or private operational logs. Report security issues through [SECURITY.md](./SECURITY.md).

By intentionally submitting a contribution for inclusion, you agree to license it under Apache-2.0,
as described in section 5 of [LICENSE](./LICENSE). Submit work you have the right to contribute and
preserve the notices and licenses of any third-party material.
