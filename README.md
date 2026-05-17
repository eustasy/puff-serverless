# Puff Serverless

[![CI: Build](https://github.com/eustasy/puff-serverless/actions/workflows/build.yml/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/build.yml)
[![CI: Typecheck](https://github.com/eustasy/puff-serverless/actions/workflows/typecheck.yml/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/typecheck.yml)
[![CI: Prettier](https://github.com/eustasy/puff-serverless/actions/workflows/prettier.yml/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/prettier.yml)
[![CodeQL](https://github.com/eustasy/puff-serverless/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/github-code-scanning/codeql)
[![Dependabot Updates](https://github.com/eustasy/puff-serverless/actions/workflows/dependabot/dependabot-updates/badge.svg)](https://github.com/eustasy/puff-serverless/actions/workflows/dependabot/dependabot-updates)

## Project Goals & Use Case

The intent of Puff Serverless is to allow the deployment of hyper-scalable solution for centralized single sign-on, access control, and unified billing for multiple organisations across multiple applications.

## Technologies

We run JavaScript on [Cloudflare Workers](https://developers.cloudflare.com/workers/) with [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), using [Pages Functions](https://developers.cloudflare.com/pages/functions/) directory routing for endpoints and [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) for HTML/CSS/client-side JS. APIs return full HTML via [HTMX](https://htmx.org/) to update in-page. Data is stored within Postgres-like [CockroachDB](https://www.cockroachlabs.com/) accessed via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/).

More can be read in [Architecture.md](ARCHITECTURE.md)
