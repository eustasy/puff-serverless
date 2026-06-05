import * as kv from "../../../../../../../../../../../src/team-keyvalues.js"
import { EVENTS } from "../../../../../../../../../../../src/hooks/events.js"
import { createGranteeEntitlementRemoveHandler } from "../../../../../../../../../../../src/utilities/entitlements-endpoint.js"

export const { onRequestPost, onRequest } = createGranteeEntitlementRemoveHandler({
  kv,
  paramName: "team_uuid",
  granteeType: "team",
  eventType: EVENTS.ORG_TEAM_ENTITLEMENTS_REMOVED,
})
