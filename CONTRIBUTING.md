# Contributing to Repeat

Thanks for helping! This document covers how the repository is organised, how to run things locally, and what a good pull request looks like.

## Ground rules

- **Official APIs only.** Providers must use documented, platform-sanctioned APIs and OAuth. Scraping, browser automation, cookie reuse or reverse-engineered endpoints will not be merged, whatever the reason.
- **Do not fake functionality.** If a platform does not support something (personal Instagram accounts, Facebook profiles...), document the restriction rather than working around it.
- **Never log or expose credentials.** Tokens stay inside `ProviderCredentials` objects on the server.
- **Keep the core provider-agnostic.** Platform-specific code lives in `packages/providers/*`, nowhere else.

## Getting set up

```bash
pnpm install
cp .env.example .env               # fill SESSION_SECRET and TOKEN_ENCRYPTION_KEY; MOCK_PROVIDER_ENABLED=true
docker compose up -d db redis
pnpm db:migrate
pnpm dev
```

See the README for details and provider credentials.

## Repository layout

| Path                   | Contents                                                                        |
| ---------------------- | ------------------------------------------------------------------------------- |
| `apps/web`             | Next.js UI and HTTP API (route handlers are thin wrappers around core services) |
| `apps/worker`          | BullMQ worker running the publishing engine                                     |
| `packages/core`        | Domain services and the publishing engine                                       |
| `packages/auth`        | Users, sessions, CSRF, generic OAuth flow                                       |
| `packages/queue`       | BullMQ adapter                                                                  |
| `packages/database`    | Prisma schema + migrations                                                      |
| `packages/types`       | DTOs and zod request schemas shared with clients                                |
| `packages/providers/*` | Provider SDK and platform adapters                                              |

## Checks to run before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test                      # unit
pnpm test:integration          # needs PostgreSQL (docker compose up -d db)
pnpm --filter @repeat/web test:e2e   # optional, needs the running stack
pnpm format:check
```

CI runs the same commands. Please do not disable rules or silence errors with `any`; ask in the PR if something is genuinely hard to type.

## Database changes

Edit `packages/database/prisma/schema.prisma`, then:

```bash
pnpm --filter @repeat/database migrate:dev --name describe_the_change
```

Commit the generated migration folder. Keep migrations additive when possible; destructive changes need a note in the PR.

## Adding a provider

Follow [docs/providers.md](docs/providers.md). A provider PR should include:

- the publisher (and connector) with unit tests against a fake HTTP server,
- error mapping (`normalizeError`) covering the platform's documented error codes,
- a README section describing credentials, account requirements, review/verification steps and limits,
- registration in `packages/providers/all`.

## Commit messages and PRs

- One logical change per PR; describe _why_ in the description.
- Reference issues where applicable.
- Include screenshots for UI changes.

## Reporting security issues

Please do not open public issues for vulnerabilities. Email the maintainers (see the repository's security policy or the profile of the maintainers) with details; we aim to acknowledge within a few days.

## License

By contributing you agree that your contributions are licensed under the AGPL-3.0, like the rest of the project.
