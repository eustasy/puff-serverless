import { sessionAuthMiddleware } from "../../../../src/utilities/session-auth.js"

// This will apply the sessionAuthMiddleware to all requests under /api/db/auth.
export const onRequest = [sessionAuthMiddleware]
