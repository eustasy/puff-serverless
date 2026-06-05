import * as kv from "../../../../../../../../../../../src/team-keyvalues.js"
import { createGranteeEntitlementListHandler } from "../../../../../../../../../../../src/utilities/entitlements-endpoint.js"

export const { onRequestGet, onRequest } = createGranteeEntitlementListHandler({
  kv,
  paramName: "team_uuid",
  granteeType: "team",
  urlSegment: "teams",
})
