# Repository Guidelines

## Project Structure & Module Organization

This repository is an npm-workspaces TypeScript monorepo. `apps/api` contains the Fastify gateway, authentication, container lifecycle, and Prisma-backed services. `apps/web` is the Next.js 15/React 19 UI; routes live under `src/app` and reusable UI under `src/components`. `apps/worker` handles scheduling and idle-container cleanup, while `packages/shared` exposes shared contracts and utilities. Database schema and seed logic live in `prisma/`. Runtime image definitions and nginx configuration are under `deploy/`; manually imported skill examples are under `examples/opencode-config/` and are not automatically deployed.

## Build, Test, and Development Commands

- `npm install` installs all workspace dependencies.
- `npx prisma generate` regenerates the Prisma client after schema changes.
- `npm run typecheck` runs TypeScript checks across every workspace.
- `npm test -w @opshelper/api` runs API unit tests with Node's built-in test runner.
- `npx tsx --test prisma/seed.test.ts` tests seed-specific behavior.
- `npm run build:web` creates the production Next.js build.
- For a fresh installation, follow `docs/guide/deployment.md`: configure `.env`, run `scripts/opshelper.py bootstrap` to migrate and initialize only an empty database, then `up`. Upgrades and restores must not seed.
- For offline x86 deployment, follow `docs/guide/offline-amd64.md` using the released image bundle and its Compose configuration. Local release archives belong in ignored `releases/`, not Git.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs. Follow existing naming: `camelCase` for functions and variables, `PascalCase` for React components and types, and kebab-case filenames such as `container-lifecycle.ts`. Keep route handlers in `apps/api/src/routes` and domain logic in `apps/api/src/lib`. No formatter or effective workspace linter is configured, so match surrounding code and rely on `npm run typecheck`.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Place API tests beside their subject as `*.test.ts`; describe observable behavior in test names. Add regression coverage for configuration parsing, lifecycle transitions, serializers, file handling, and service changes. Run the API suite and relevant seed tests before submitting.

## Commit & Pull Request Guidelines

History generally favors Conventional Commit subjects, including optional scopes: `feat: ...`, `feat(deploy): ...`, or `fix(api): ...`. Keep commits focused and use an imperative summary. Pull requests should explain behavior and deployment impact, list validation commands, link related issues, and include screenshots for UI changes. Call out Prisma migrations, new environment variables, or runtime-image changes explicitly.

## Release Documentation

- Document changes to migrations, configuration, runtime images, and backup compatibility in the relevant deployment guide or release notes.
- Keep installation-specific addresses, accounts, deployment records, credentials, logs, data, and release archives outside the repository.
- Distinguish local checks, package preparation, and actual deployment acceptance. Do not claim an unverified deployment result.

## Security & Configuration

Never commit `.env`, API keys, database credentials, logs, or local image archives. Validate schema changes with `npm run prisma:validate`; document new configuration keys in `.env.example`.
