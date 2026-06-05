import * as kv from "../../../../../../../../../../../src/team-keyvalues.js"
import { EVENTS } from "../../../../../../../../../../../src/hooks/events.js"
import { createGranteeEntitlementSetHandler } from "../../../../../../../../../../../src/utilities/entitlements-endpoint.js"

export const { onRequestPost, onRequest } = createGranteeEntitlementSetHandler({
  kv,
  paramName: "team_uuid",
  granteeType: "team",
  eventType: EVENTS.ORG_TEAM_ENTITLEMENTS_SET,
})
