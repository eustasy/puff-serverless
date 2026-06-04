# Puff Serverless

[![CI: Build](https://github.com/eustasy/puff-serverless/actions/workflows/build.yml/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/build.yml)
[![CI: Test](https://github.com/eustasy/puff-serverless/actions/workflows/test.yml/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/test.yml)
[![CI: Typecheck](https://github.com/eustasy/puff-serverless/actions/workflows/typecheck.yml/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/typecheck.yml)
[![CI: Prettier](https://github.com/eustasy/puff-serverless/actions/workflows/prettier.yml/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/prettier.yml)
[![CodeQL](https://github.com/eustasy/puff-serverless/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/github-code-scanning/codeql)
[![Dependabot Updates](https://github.com/eustasy/puff-serverless/actions/workflows/dependabot/dependabot-updates/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/dependabot/dependabot-updates)

## Project Goals & Use Case

The intent of Puff Serverless is to allow the deployment of hyper-scalable solution for centralized single sign-on, access control, and unified billing for multiple organisations across multiple applications.

## Technologies

We run JavaScript on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), using [Pages Functions](https://developers.cloudflare.com/pages/functions/) directory routing for endpoints and [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) for HTML/CSS/client-side JS. APIs return full HTML via [HTMX](https://htmx.org/) to update in-page. Data is stored within Postgres-like [CockroachDB](https://www.cockroachlabs.com/) accessed via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/).

Further reading in [`docs/`](docs/):

* [Architecture.md](docs/Architecture.md) — codebase shape, request layering, libraries, OAuth endpoints, environment variables.
* [Hierarchy.md](docs/Hierarchy.md) — the data model: Apps, Organisations, Teams, Roles, Users.
* [Development.md](docs/Development.md) — local-machine setup, tests, linting.
* [Deployment.md](docs/Deployment.md) — shipping to production with copy-paste commands.
* [Operations.md](docs/Operations.md) — running it: cron, audit log, OAuth key rotation, registering apps and providers.
