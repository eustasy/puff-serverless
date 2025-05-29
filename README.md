# Puff Serverless

## Project Goals & Use Case

The intent of Puff Serverless is to allow the deployment of hyper-scalable solution to centralize sign-on, access control, and unified billing for multiple organisations across multiple applications.

## Technologies

We run JavaScript on [Node-compatible](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) [Cloudflare Functions](https://developers.cloudflare.com/pages/functions/). APIs return full HTML via [HTMX](https://htmx.org/) to update in-page. Data is stored within Postgres-like [CoackroachDB](https://www.cockroachlabs.com/) accessed via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/).

More can be read in [Architecture.md](ARCHITECTURE.md)

## First time project setup

### Node & NPM

Use the latest Node version. We recommend you [Install NVM](https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating) if you are not already using Node.

```sh
nvm install stable
nvm use stable
```

### Postgres or CockroachDB

_Note: SQL Schema can be found in the SQL folder, one file per table. `users.sql` should be imported first as it provides the foreign key for many other tables._

#### for Local Development

You can override the Hyperdrive connection strings by setting the following in `.env`:

```sh
WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:password@localhost:5432/databasename"
```

#### for Production Deployment

TODO

## Continuous Development

```sh
npm ci
npm run dev
```

Before pushing you may wish to run linting or allow autoformatting to run, or configure your editor to automatically use prettier.

```sh
npm run lint
npm run format
```

You may also need to update types:

```sh
npx wrangler types
```

## Project Maintenance

[Dependabot](https://github.com/eustasy/puff-serverless/blob/cf-pages/.github/dependabot.yml) should update NPM and GitHub Actions with automatic pull requests.
