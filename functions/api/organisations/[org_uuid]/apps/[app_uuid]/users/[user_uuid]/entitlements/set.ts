import * as kv from "../../../../../../../../../src/user-keyvalues.js"
import { EVENTS } from "../../../../../../../../../src/hooks/events.js"
import { createGranteeEntitlementSetHandler } from "../../../../../../../../../src/utilities/entitlements-endpoint.js"

export const { onRequestPost, onRequest } = createGranteeEntitlementSetHandler({
  kv,
  paramName: "user_uuid",
  granteeType: "user",
  eventType: EVENTS.ORG_USER_ENTITLEMENTS_SET,
})
