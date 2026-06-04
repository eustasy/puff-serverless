// Automated OAuth signing-key rotation. Runs from the daily cron in
// `src/cron.ts` (which only rotates once the active key is old enough —
// see `maybeRotateSigningKey`); can also be invoked from the operator
// endpoint at `functions/api/db/auth/admin/oauth-keys/rotate.ts`.
//
// One-shot procedure:
//   1. Generate a fresh ES256 keypair in-Worker (Web Crypto).
//   2. Sign and verify a probe payload — bail without promoting if either
//      fails. A broken keypair must never reach `oauth:keys:active`.
//   3. If a previous active key exists, write its PUBLIC half to
//      `oauth:keys:retired` with `expirationTtl = 7200s` (1h longest-lived
//      JWT + 1h safety margin). The private half is dropped — there is no
//      use for it past this point.
//   4. Write the new private JWK to `oauth:keys:active`.
//   5. Emit `oauth.signing_key.rotated` (alert) or
//      `oauth.signing_key.rotation.failed` (critical) on the audit log.
//
// Partial-state safety: if the cron crashes between step 3 and step 4 the
// system still has a working active key (the now-also-retired one) and
// JWKS still serves both. The next cron tick re-rotates cleanly.

import { Client } from "pg"
import { JWT_ALG, _resetOAuthKeyCache, jwkThumbprint, type SigningJwk, type StoredActiveKey, type StoredRetiredKey } from "./oauth-keys.js"
import { emit } from "./hooks/dispatch.js"
import { EVENTS } from "./hooks/events.js"

const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const
const SIGN_ALG = { name: "ECDSA", hash: "SHA-256" } as const

const KV_KEY_ACTIVE = "oauth:keys:active"
const KV_KEY_RETIRED = "oauth:keys:retired"

// Retired key sticks around for 2× longest-lived JWT (1h access/ID token
// lifetime → 1h grace) to cover clock skew and the ~60s KV propagation lag.
const RETIRED_TTL_SECONDS = 7200

const DEFAULT_ROTATION_INTERVAL_DAYS = 7
const SECONDS_PER_DAY = 86_400

export interface RotationDecision {
  rotated: boolean
  reason: string
  new_kid?: string
  retired_kid?: string
}

/**
 * Decide whether to rotate this tick and, if so, rotate. The cron fires
 * daily, but a rotation only happens once the active key is older than
 * `OAUTH_KEY_ROTATION_INTERVAL_DAYS` (default 7) — so the effective cadence
 * is weekly. Firing the cron more often than the interval keeps rotation
 * prompt without depending on exact clock timing; the env var lets
 * operators slow the cadence (or speed it up to rehearse in staging).
 *
 * `meta` is forwarded into the audit event so the operator can tell a cron
 * rotation from a manual one when reading the log.
 */
export async function maybeRotateSigningKey(
  env: Env,
  meta: { cron?: string; trigger?: "cron" | "manual" } = {}
): Promise<RotationDecision> {
  if (!env.KV_OAUTH_KEYS) {
    return { rotated: false, reason: "KV_OAUTH_KEYS binding missing" }
  }

  const intervalDays = parseIntervalDays(env.OAUTH_KEY_ROTATION_INTERVAL_DAYS)
  const minAgeMs = intervalDays * SECONDS_PER_DAY * 1000

  const existing = await env.KV_OAUTH_KEYS.get<StoredActiveKey>(KV_KEY_ACTIVE, "json")
  if (existing && existing.created_at) {
    const createdAt = Date.parse(existing.created_at)
    if (Number.isFinite(createdAt) && Date.now() - createdAt < minAgeMs) {
      return {
        rotated: false,
        reason: `active key age below interval (${intervalDays}d)`,
      }
    }
  }

  return rotateSigningKey(env, { ...meta, trigger: meta.trigger ?? "cron" })
}

/**
 * Unconditional rotation. Generates a new keypair, validates it,
 * promotes the previous active to retired, writes the new active, and
 * emits an audit event. Exposed separately from `maybeRotateSigningKey`
 * for the operator endpoint, which always rotates on demand.
 */
export async function rotateSigningKey(env: Env, meta: { cron?: string; trigger?: "cron" | "manual" } = {}): Promise<RotationDecision> {
  if (!env.KV_OAUTH_KEYS) {
    throw new Error("rotateSigningKey: KV_OAUTH_KEYS binding missing")
  }

  let newPrivateJwk: SigningJwk
  let newPublicJwk: SigningJwk
  let newKid: string
  try {
    const generated = await generateEs256Jwks()
    newPrivateJwk = generated.privateJwk
    newPublicJwk = generated.publicJwk
    newKid = await jwkThumbprint(newPublicJwk)
    await assertKeypairUsable(newPrivateJwk, newPublicJwk)
  } catch (error) {
    await emitRotationFailure(env, meta, error)
    throw error
  }

  // Promote the outgoing active (if any) to retired BEFORE swapping in the
  // new one. Crashing here leaves the old key still active — recoverable.
  // Crashing in the opposite order would leave a window with no usable
  // verification key for JWTs minted by the old signer.
  const outgoing = await env.KV_OAUTH_KEYS.get<StoredActiveKey>(KV_KEY_ACTIVE, "json")
  let retiredKid: string | undefined
  if (outgoing) {
    const outgoingPub: SigningJwk = {
      kty: outgoing.jwk.kty,
      crv: outgoing.jwk.crv,
      x: outgoing.jwk.x,
      y: outgoing.jwk.y,
    }
    retiredKid = outgoing.kid ?? (await jwkThumbprint(outgoingPub))
    const retired: StoredRetiredKey = {
      jwk: outgoingPub,
      kid: retiredKid,
      retired_at: new Date().toISOString(),
    }
    await env.KV_OAUTH_KEYS.put(KV_KEY_RETIRED, JSON.stringify(retired), {
      expirationTtl: RETIRED_TTL_SECONDS,
    })
  }

  const active: StoredActiveKey = {
    jwk: newPrivateJwk,
    kid: newKid,
    created_at: new Date().toISOString(),
  }
  await env.KV_OAUTH_KEYS.put(KV_KEY_ACTIVE, JSON.stringify(active))

  _resetOAuthKeyCache()

  await emitRotationSuccess(env, meta, {
    new_kid: newKid,
    retired_kid: retiredKid ?? null,
  })

  return {
    rotated: true,
    reason: "rotated",
    new_kid: newKid,
    retired_kid: retiredKid,
  }
}

/**
 * Swap active and retired in KV. The active becomes the retired (with a
 * fresh TTL), and the retired — if there is one — becomes active.
 *
 * Operator escape hatch for "the rotation cron promoted a key we cannot
 * use" (the new active fails to sign in a real path, etc.). The retired
 * key is only the PUBLIC half, so the swap can only restore a verifiable
 * key, not a signing one — without a private retired key there is nothing
 * to restore. Treat this as a last-ditch recovery, not a routine action.
 */
export async function promoteRetiredKey(
  env: Env,
  meta: { actor_user_uuid?: string | null } = {}
): Promise<{ promoted: boolean; reason: string; new_kid?: string }> {
  if (!env.KV_OAUTH_KEYS) {
    throw new Error("promoteRetiredKey: KV_OAUTH_KEYS binding missing")
  }
  const retired = await env.KV_OAUTH_KEYS.get<StoredRetiredKey>(KV_KEY_RETIRED, "json")
  if (!retired) {
    return { promoted: false, reason: "no retired key to promote" }
  }
  if (typeof retired.jwk.d !== "string") {
    return {
      promoted: false,
      reason:
        "retired key is public-only — promotion would leave the Worker " +
        "unable to sign. Run rotateSigningKey to mint a fresh key instead.",
    }
  }

  const previousActive = await env.KV_OAUTH_KEYS.get<StoredActiveKey>(KV_KEY_ACTIVE, "json")
  if (previousActive) {
    const pub: SigningJwk = {
      kty: previousActive.jwk.kty,
      crv: previousActive.jwk.crv,
      x: previousActive.jwk.x,
      y: previousActive.jwk.y,
    }
    const replaced: StoredRetiredKey = {
      jwk: pub,
      kid: previousActive.kid ?? (await jwkThumbprint(pub)),
      retired_at: new Date().toISOString(),
    }
    await env.KV_OAUTH_KEYS.put(KV_KEY_RETIRED, JSON.stringify(replaced), {
      expirationTtl: RETIRED_TTL_SECONDS,
    })
  } else {
    await env.KV_OAUTH_KEYS.delete(KV_KEY_RETIRED)
  }

  const promoted: StoredActiveKey = {
    jwk: retired.jwk,
    kid: retired.kid ?? (await jwkThumbprint(retired.jwk)),
    created_at: new Date().toISOString(),
  }
  await env.KV_OAUTH_KEYS.put(KV_KEY_ACTIVE, JSON.stringify(promoted))
  _resetOAuthKeyCache()

  await withAuditClient(env, async (dbClient) => {
    await emit(dbClient, null, {
      event_type: EVENTS.OAUTH_SIGNING_KEY_RETIRED_PROMOTED,
      actor_user_uuid: meta.actor_user_uuid ?? null,
      event_metadata: { new_kid: promoted.kid, trigger: "manual" },
    })
  })

  return { promoted: true, reason: "promoted", new_kid: promoted.kid }
}

async function generateEs256Jwks(): Promise<{
  privateJwk: SigningJwk
  publicJwk: SigningJwk
}> {
  const pair = (await crypto.subtle.generateKey(ECDSA_PARAMS, true, ["sign", "verify"])) as CryptoKeyPair
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as SigningJwk
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as SigningJwk
  return { privateJwk, publicJwk }
}

async function assertKeypairUsable(privateJwk: SigningJwk, publicJwk: SigningJwk): Promise<void> {
  const [signingKey, verifyKey] = await Promise.all([
    crypto.subtle.importKey("jwk", privateJwk, ECDSA_PARAMS, false, ["sign"]),
    crypto.subtle.importKey("jwk", publicJwk, ECDSA_PARAMS, true, ["verify"]),
  ])
  const probe = new TextEncoder().encode("puff-key-rotation-probe")
  const signature = await crypto.subtle.sign(SIGN_ALG, signingKey, probe)
  const verified = await crypto.subtle.verify(SIGN_ALG, verifyKey, signature, probe)
  if (!verified) {
    throw new Error("Newly generated signing keypair failed self-verification")
  }
}

function parseIntervalDays(raw: string | undefined): number {
  if (!raw) return DEFAULT_ROTATION_INTERVAL_DAYS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ROTATION_INTERVAL_DAYS
  return Math.floor(n)
}

interface RotationMeta {
  cron?: string
  trigger?: "cron" | "manual"
}

async function emitRotationSuccess(env: Env, meta: RotationMeta, details: { new_kid: string; retired_kid: string | null }): Promise<void> {
  await withAuditClient(env, async (dbClient) => {
    await emit(dbClient, null, {
      event_type: EVENTS.OAUTH_SIGNING_KEY_ROTATED,
      event_metadata: {
        new_kid: details.new_kid,
        retired_kid: details.retired_kid,
        trigger: meta.trigger ?? "cron",
        cron: meta.cron ?? null,
        algorithm: JWT_ALG,
      },
    })
  })
}

async function emitRotationFailure(env: Env, meta: RotationMeta, error: unknown): Promise<void> {
  await withAuditClient(env, async (dbClient) => {
    await emit(dbClient, null, {
      event_type: EVENTS.OAUTH_SIGNING_KEY_ROTATION_FAILED,
      event_outcome: "failure",
      event_metadata: {
        trigger: meta.trigger ?? "cron",
        cron: meta.cron ?? null,
        error: error instanceof Error ? error.message : String(error),
      },
    })
  })
}

/**
 * Open a short-lived pg client, run `body` with it, and close it. Audit
 * write failures are logged — they must not mask the rotation outcome.
 */
async function withAuditClient(env: Env, body: (dbClient: DbClient) => Promise<void>): Promise<void> {
  if (!env.HYPERDRIVE?.connectionString) {
    console.warn("OAuth key rotation: HYPERDRIVE missing, skipping audit emit.")
    return
  }
  const client = new Client(env.HYPERDRIVE.connectionString)
  try {
    await client.connect()
    await body(client)
  } catch (err) {
    console.error("OAuth key rotation: audit emit failed:", err)
  } finally {
    try {
      await client.end()
    } catch (endError) {
      console.error("OAuth key rotation: error closing audit DB client:", endError)
    }
  }
}
