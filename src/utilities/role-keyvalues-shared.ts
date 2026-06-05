import {
  type KeyValueSpec,
  type Owner,
  deleteKeyValueGeneric,
  readKeyValueGeneric,
  readKeyValuesGeneric,
  searchKeyValuesGeneric,
  upsertKeyValue,
} from "./keyvalues-shared.js"

export type { KeyValueSpec, Owner }

export function createRoleKvModule<RowT>(
  spec: KeyValueSpec,
  isValidRole: (role: string) => boolean,
  invalidRoleMessage: string,
) {
  const ROLE_ERROR = { success: false as const, message: invalidRoleMessage, status: 400 as const }
  const reject = (role: string) => (isValidRole(role) ? null : ROLE_ERROR)

  return {
    readKeyValue(dbClient: DbClient, scope_uuid: string, role: string, owner: Owner, key: string): Promise<Envelope<{ value: string }>> {
      const r = reject(role)
      return r ? Promise.resolve(r) : readKeyValueGeneric(dbClient, spec, [scope_uuid, role], owner, key)
    },
    readKeyValues(dbClient: DbClient, scope_uuid: string, role: string, owner: Owner): Promise<Envelope<{ pairs: RowT[] }>> {
      const r = reject(role)
      return r ? Promise.resolve(r) : readKeyValuesGeneric<RowT>(dbClient, spec, [scope_uuid, role], owner)
    },
    searchKeyValues(dbClient: DbClient, scope_uuid: string, role: string, owner: Owner, pattern: string): Promise<Envelope<{ pairs: RowT[] }>> {
      const r = reject(role)
      return r ? Promise.resolve(r) : searchKeyValuesGeneric<RowT>(dbClient, spec, [scope_uuid, role], owner, pattern)
    },
    setKeyValue(dbClient: DbClient, scope_uuid: string, role: string, owner: Owner, key: string, value: string): Promise<Envelope<{ created: boolean }>> {
      const r = reject(role)
      return r ? Promise.resolve(r) : upsertKeyValue(dbClient, spec.table, spec.subjectColumns, [scope_uuid, role], owner, key, value)
    },
    deleteKeyValue(dbClient: DbClient, scope_uuid: string, role: string, owner: Owner, key: string): Promise<Envelope> {
      const r = reject(role)
      return r ? Promise.resolve(r) : deleteKeyValueGeneric(dbClient, spec, [scope_uuid, role], owner, key)
    },
  }
}
