import * as kv from "../../../../../../../../../../../src/user-keyvalues.js"
import { createGranteeEntitlementListHandler } from "../../../../../../../../../../../src/utilities/entitlements-endpoint.js"

export const { onRequestGet, onRequest } = createGranteeEntitlementListHandler({
  kv,
  paramName: "user_uuid",
  granteeType: "user",
  urlSegment: "users",
})
