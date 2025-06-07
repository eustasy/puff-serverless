# Puff Serverless

## Project Goals & Use Case

The intent of Puff Serverless is to allow the deployment of hyper-scalable solution to centralize sign-on, access control, and unified billing for multiple organisations across multiple applications.

## Technologies

We run JavaScript on [Node-compatible](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) [Cloudflare Functions](https://developers.cloudflare.com/pages/functions/). APIs return full HTML via [HTMX](https://htmx.org/) to update in-page. Data is stored within Postgres-like [CoackroachDB](https://www.cockroachlabs.com/) accessed via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/).

More can be read in [Architecture.md](ARCHITECTURE.md)
