import { sameOriginWriteGuard } from "../../../src/utilities/cors.js"
import { createDbMiddleware } from "../../../src/utilities/db-middleware.js"

// Applies to every request under /api/db (including /api/db/auth). The
// same-origin guard runs first, so a blocked write never opens a DB connection.
export const onRequest = [sameOriginWriteGuard, createDbMiddleware("/api/db")]
