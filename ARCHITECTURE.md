# Architecture

## Deployment
Folder | Contents | Deployed to
-------|----------|------------
[public](https://github.com/eustasy/puff-serverless/tree/main/public) | All static files: HTML, CSS, Client-Side JS. | Cloduflare Pages
[functions](https://github.com/eustasy/puff-serverless/tree/main/functions) | Dynamic endpoints: pages that must load with pre-inserted data. | Cloudflare Workers
[functions/api](https://github.com/eustasy/puff-serverless/tree/main/functions/api) | API Endpoints | Cloudflare Workers
[src](https://github.com/eustasy/puff-serverless/tree/main/src) | Backend Code | ~

# Libraries
Library | Version | Type | Location | Source
--------|---------|------|----------|-------
HTMX | 1.9.6 | Client-Side JS | [public/htmx_1.9.6.min.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/htmx_1.9.6.min.js) | [htmx.org](https://htmx.org/)
Tailwind CSS | 3.3.3 | CSS | ~ | [tailwindcss.com](https://tailwindcss.com/)

## Actions
- Register
  - Verify Email
- Log in
  - Verify password
  - Verify 2nd factor
  - Create a session
- Log out
  - Terminate a session
- Reset password
- Account Mangement
  - Verify a session
  - Add backup email
  - Change primary email
  - Change password
  - Add 2nd factor
  - Remove 2nd factor
  - List sessions
  - Terminate all sessions
