import { createDbMiddleware } from "../../../src/utilities/db-middleware.js"

export const onRequest = createDbMiddleware("/api/billing")
