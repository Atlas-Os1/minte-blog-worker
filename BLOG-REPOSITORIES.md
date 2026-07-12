# Daily blog repository registry

The daily build-note and blog activity feed is intentionally curated. It must not scan every repository visible to the GitHub token.

## Current registry

### Agents, skills, and tools

- `Atlas-Os1/Hermes-agents`
- `Atlas-Os1/atlas-lanes`
- `mintedmaterial/cleo-agent`
- `Atlas-Os1/atlas-skills`
- `Atlas-Os1/atlas-cf-skills`
- `Atlas-Os1/openclaw-memory-vectorize`
- `Atlas-Os1/flo-social-worker`
- `Atlas-Os1/trading-judge-agent`
- `Atlas-Os1/OpenMontage`

### Projects

- `Atlas-Os1/r2-brain`
- `Atlas-Os1/trading-r2-dashboard`
- `Atlas-Os1/smart-alarm`

### Blog and businesses

- `Atlas-Os1/minte-blog-worker`
- `Atlas-Os1/srvcflo-app-template`
- `Atlas-Os1/handy-beaver`
- `mintedmaterial/kiamichi-Biz-Connect`
- `mintedmaterial/srvcflo-marketing`
- `mintedmaterial/public-view`
- `mintedmaterial/Twisted`

## Adding a repository

When a new repo becomes part of the operating system, Dev or LocDev should update `src/workflows/blog-repos.ts` with its owner-qualified name and area. The change should include a short note in the handoff or commit message explaining why the repo belongs in the daily feed.

Do not add archived, experimental, or unrelated repos just because the GitHub token can see them. The registry is the editorial boundary for daily build notes.

## Excluded legacy entries

The old helper entries `Atlas-Os1/devflo-moltworker` and `Atlas-Os1/atlas-dashboard` are intentionally removed from the active registry.
