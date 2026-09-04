# Open-source preparation

Prepared on 2026-09-04. This records repository preparation, not approval to publish or a security
certification. The GitHub repository was private when checked. No visibility change, history rewrite,
merge, or deployment was performed.

## License and positioning

- `LICENSE` is the unmodified Apache-2.0 text from <https://www.apache.org/licenses/LICENSE-2.0.txt>.
- `NOTICE` attributes the project to Zaks.io LLC. The legal pages already identify that company;
  the available Git history starts in 2025.
- All 24 JavaScript package manifests, nine Rust crate manifests, and 71 existing Rust SPDX headers
  use Apache-2.0. Package publication settings are unchanged.
- `THIRD_PARTY_NOTICES.md` retains the upstream MIT notice for copied shadcn/ui components.
- Existing Otto source-provenance comments are preserved. ADR 0017 records Otto as the owner's own
  code. Third-party dependencies retain their own licenses; this is not a dependency license audit
  or a redistribution notice bundle for compiled desktop releases.
- The README, setup map, agent guide, and LLM documentation index describe company dev tooling,
  unfinished agent analytics, and company-specific deployment configuration.
- `CONTRIBUTING.md` sets contribution expectations. `SECURITY.md` uses the security contact already
  published in the web source. Delivery to that mailbox was not tested.

## Verification

- `bun install --frozen-lockfile` passed. The initial worktree setup's package-install failure did
  not recur.
- Prettier checks passed for changed Markdown, JSON, and TypeScript files.
- `cargo metadata --no-deps --locked --format-version 1` passed; every workspace crate reports
  Apache-2.0.
- Local links in the root README, setup guide, contribution guide, and security policy resolve.
- The changed LLM documentation route passed ESLint. No runtime logic was changed. Rust source
  diffs were checked to contain SPDX substitutions only.
- The bounded local author-QA review found no remaining documentation blocker after the hosted
  guide caveats and shadcn/ui attribution were added.
- No deployment or fresh-account end-to-end setup was tested.

## Secret scan scope

Gitleaks 8.30.1 scanned a snapshot of all tracked files and the full, non-shallow Git history
reachable from available local refs with `--log-opts=--all`. Both scans used full redaction and
ignored inline allow comments. Reports are stored outside the repository and contain no raw secret
values. The tree scan reported 35 matches; history reported 14,754 matches, many repeated across
commits. A nonzero scanner exit is expected for these findings and is not a clean pass.

The reviewed matches are synthetic test keys and redaction canaries, JSX identifiers, public Auth0
client configuration, and documentation examples. No live secret credential was identified in these
findings. This is a classification of scanner results, not proof that no secret exists.

History-only configuration matches examined in `workers/web/.env.prod`, the old Raw API Wrangler
files, and the architecture guide are Auth0 client IDs. Historical curl examples in `CLAUDE.md`,
`SETUP.md`, and the provider guide use placeholders. No history was rewritten and no credentials
were rotated.

## Publication review

Review Git history as well as the final tree before changing visibility. Secret-scanner matches
must be classified; an empty scan would not establish that private conversations or business
information are absent. GitHub issues, pull requests, Actions logs and artifacts, and release assets
also need a separate publication review because they are outside the source-tree scan.

Company resource IDs, hostnames, internal workflow documents, and tracker links remain in the repo.
These are not automatically credentials, but publishing them is intentional disclosure. A fork must
supply its own infrastructure and configuration. The repository preparation does not verify a
supported self-hosted installation or the remaining Agent Conversation Analytics production gates.

Desktop icons and the web favicon have no provenance record in the checked files. The audit found
no evidence that they came from a third party, but ownership was not independently established.
Confirm their origin before publication or add the applicable third-party attribution.
