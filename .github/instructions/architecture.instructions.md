---
applyTo: "**"
---

# Architecture Instructions

This document provides instructions for the architecture of the project. It is intended to guide ai assistants in maintaining a consistent and scalable codebase.

## General Guidelines

- **Scalability**: Design components to be scalable to handle massively concurrent workloads.
- **Documentation**: Document all components with unclear interactions or intentions within the codebase.
- **Modularity**: Ensure that the code is modular and components are reusable.

## Structure

- The `functions\api` directory contains all code for dynamic content.
- The `public` directory contains static content. This includes:
  - HTML files
  - CSS files
  - Client-Side JavaScript files
  - Images
- The `src` directory contains all code for the backend logic.

## API Design

- The API is fetched with HTMX.
- As such the API usually takes simple GET and POST requests and usually returns HTML.
- It can also return a header like HX-Redirect to redirect the user to a different page.
- The API should be designed to be stateless, meaning that each request should contain all the information needed to process it.
- Use appropriate HTTP status codes to indicate the result of the request (e.g., 200 for success, 404 for not found, etc.).
- Ensure that the API is secure and does not expose sensitive information.
- Additional information on HTMX can be found in the [HTMX reference](https://htmx.org/reference/) and [HTMX documentation](https://htmx.org/docs/).
