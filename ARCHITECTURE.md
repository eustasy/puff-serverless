# Architecture

## Deployment

### Directories

| Folder                                                                              | Contents                                                        | Deployed to        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------ |
| [public](https://github.com/eustasy/puff-serverless/tree/main/public)               | All static files: HTML, CSS, Client-Side JS.                    | Cloduflare Pages   |
| [functions](https://github.com/eustasy/puff-serverless/tree/main/functions)         | Dynamic endpoints: pages that must load with pre-inserted data. | Cloudflare Workers |
| [functions/api](https://github.com/eustasy/puff-serverless/tree/main/functions/api) | API Endpoints                                                   | Cloudflare Workers |
| [src](https://github.com/eustasy/puff-serverless/tree/main/src)                     | Backend Code                                                    | Cloudflare Workers |

### Special Files

| File                                                                                             | Contents                           | Deployed to                                                                                               |
| ------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [public/\_redirects](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_redirects) | Redirect Rules                     | [Cloudflare Pages Redirects](https://developers.cloudflare.com/pages/platform/redirects/)                 |
| [public/\_headers](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/_headers)     | Headers (Pages Only)               | [Cloudflare Pages Headers](https://developers.cloudflare.com/pages/platform/headers/)                     |
| _build.sh_                                                                                       | Build Commands                     | [Cloudflare Pages Build](https://developers.cloudflare.com/pages/how-to/build-commands-branches/)         |
| _functions/api/\_middleware.js_                                                                  | Headers and Authentication for API | [Cloudflare Functions Middleware](https://developers.cloudflare.com/pages/platform/functions/middleware/) |

## Libraries

| Library | Version | Type           | Location                                                                                                      | Source                        |
| ------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| HTMX    | 1.9.7   | Client-Side JS | [public/htmx_1.9.7.min.js](https://github.com/eustasy/puff-serverless/blob/cf-pages/public/htmx_1.9.7.min.js) | [htmx.org](https://htmx.org/) |

## APIs

https://haveibeenpwned.com/API/v2#SearchingPwnedPasswordsByRange

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
