// Built per-call, not held as a module-scope constant: constructing a Response
// in the Workers global scope is a disallowed operation (its body is bound to
// a request's I/O context), so it must happen inside a handler invocation.
export function sessionExpired(): Response {
  return new Response('<p class="result-negative">Your login session has expired. Please log in again.</p>', {
    status: 400,
    headers: { "Content-Type": "text/html" },
  })
}
