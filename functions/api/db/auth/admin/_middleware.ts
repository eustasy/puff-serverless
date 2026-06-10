import { operatorAuthMiddleware } from "../../../../../src/utilities/operator-auth.js"

// Operator-only gate for /api/db/auth/admin/... — see operatorAuthMiddleware.
export const onRequest = [operatorAuthMiddleware]
