// base64url helpers
function base64urlToBuffer(b64url) {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded)
  const buf = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i)
  return buf.buffer
}

function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

// Prepare PublicKeyCredentialCreationOptions from JSON options
function prepareCreationOptions(opts) {
  return {
    ...opts,
    challenge: base64urlToBuffer(opts.challenge),
    user: {
      ...opts.user,
      id: base64urlToBuffer(opts.user.id),
    },
    excludeCredentials: (opts.excludeCredentials ?? []).map((c) => ({
      ...c,
      id: base64urlToBuffer(c.id),
    })),
  }
}

// Prepare PublicKeyCredentialRequestOptions from JSON options
function prepareRequestOptions(opts) {
  return {
    ...opts,
    challenge: base64urlToBuffer(opts.challenge),
    allowCredentials: (opts.allowCredentials ?? []).map((c) => ({
      ...c,
      id: base64urlToBuffer(c.id),
    })),
  }
}

// Serialize a PublicKeyCredential to plain JSON
function serializeCredential(cred) {
  const response = cred.response
  const obj = {
    id: cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
    },
  }

  if (response.attestationObject) {
    obj.response.attestationObject = bufferToBase64url(response.attestationObject)
    if (typeof response.getTransports === "function") {
      obj.response.transports = response.getTransports()
    }
  }

  if (response.authenticatorData) {
    obj.response.authenticatorData = bufferToBase64url(response.authenticatorData)
    obj.response.signature = bufferToBase64url(response.signature)
    if (response.userHandle) {
      obj.response.userHandle = bufferToBase64url(response.userHandle)
    }
  }

  return obj
}

// Remembers the last successfully-used login on this device so the login page
// can pre-fill the email and auto-offer a passkey. `usedPasskey` is sticky per
// email: a passkey sign-in sets it, and a later password sign-in for the same
// email keeps it (the device still holds the passkey); a different email resets.
const LAST_LOGIN_KEY = "puff_last_login"

function readLastLogin() {
  try {
    const raw = localStorage.getItem(LAST_LOGIN_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function rememberLogin(email, viaPasskey) {
  try {
    const prev = readLastLogin()
    const usedPasskey = viaPasskey || (prev && prev.email === email && prev.usedPasskey === true)
    localStorage.setItem(LAST_LOGIN_KEY, JSON.stringify({ email, usedPasskey: !!usedPasskey }))
  } catch {
    // localStorage unavailable (private mode / disabled) — feature degrades.
  }
}

// Stop auto-offering a passkey on this device while keeping the remembered
// email for pre-fill. Called when the device's "I hold a passkey" belief has
// gone stale: the passkey was removed (here or elsewhere) so the auto-offer
// would otherwise keep prompting for a credential that no longer exists.
function forgetPasskey() {
  try {
    const prev = readLastLogin()
    if (prev && prev.usedPasskey) {
      localStorage.setItem(LAST_LOGIN_KEY, JSON.stringify({ email: prev.email, usedPasskey: false }))
    }
  } catch {
    // localStorage unavailable — nothing to forget.
  }
}

// Registration — called from the register passkey button in account.html
async function registerPasskey() {
  const msgArea = document.getElementById("passkey-message-area")
  if (msgArea) msgArea.innerHTML = ""

  let startData
  try {
    const startRes = await fetch("/api/passkeys/register/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
    if (!startRes.ok) {
      throw new Error("Could not start passkey registration.")
    }
    startData = await startRes.json()
  } catch {
    if (msgArea) msgArea.innerHTML = '<p class="result-negative">Could not start passkey registration. Please try again.</p>'
    return
  }

  let credential
  try {
    credential = await navigator.credentials.create({
      publicKey: prepareCreationOptions(startData.options),
    })
  } catch {
    if (msgArea) msgArea.innerHTML = '<p class="result-negative">Passkey creation was cancelled or failed.</p>'
    return
  }

  try {
    const completeRes = await fetch("/api/passkeys/register/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializeCredential(credential)),
    })
    const html = await completeRes.text()
    if (msgArea) msgArea.innerHTML = html
    if (completeRes.ok) {
      htmx.trigger(document.body, "passkeysChanged")
    }
  } catch {
    if (msgArea) msgArea.innerHTML = '<p class="result-negative">Failed to complete passkey registration.</p>'
  }
}

// Authentication — called from the passkey login button in login.html, or
// automatically on page load when this device last signed in with a passkey.
// `auto` offers fall back to the visible login form silently rather than
// surfacing errors, and forget the passkey when the device can't satisfy it.
async function authenticateWithPasskey(auto = false) {
  const resultArea = document.getElementById("passkey-result")
  if (resultArea) resultArea.innerHTML = ""

  const emailInput = document.getElementById("email")
  const email = emailInput ? emailInput.value.trim() : ""
  if (!email) {
    if (!auto && resultArea) resultArea.innerHTML = '<p class="result-negative">Please enter your email address.</p>'
    return
  }

  let options
  try {
    const formData = new FormData()
    formData.append("email", email)
    const startRes = await fetch("/api/passkeys/authenticate/start", {
      method: "POST",
      body: formData,
    })
    if (!startRes.ok) {
      throw new Error("Could not start passkey authentication.")
    }
    options = await startRes.json()
  } catch {
    // A transient start failure on an auto-offer just falls back to the form;
    // it isn't evidence the passkey is gone, so don't forget it.
    if (!auto && resultArea)
      resultArea.innerHTML = '<p class="result-negative">Could not start passkey authentication. Please try again.</p>'
    return
  }

  let credential
  try {
    credential = await navigator.credentials.get({
      publicKey: prepareRequestOptions(options),
    })
  } catch {
    // An auto-offer the device can't satisfy (passkey removed here or on
    // another device) must not keep prompting on every visit — forget it and
    // fall back to the form. Manual attempts surface the failure as before.
    if (auto) {
      forgetPasskey()
      return
    }
    if (resultArea) resultArea.innerHTML = '<p class="result-negative">Passkey authentication was cancelled or failed.</p>'
    return
  }

  try {
    const completeRes = await fetch("/api/passkeys/authenticate/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializeCredential(credential)),
    })

    // Handle redirect from HX-Redirect header
    const redirect = completeRes.headers.get("HX-Redirect")
    if (redirect) {
      rememberLogin(email, true)
      window.location.href = redirect
      return
    }

    const html = await completeRes.text()
    if (resultArea) resultArea.innerHTML = html
  } catch {
    if (resultArea) resultArea.innerHTML = '<p class="result-negative">Passkey authentication failed.</p>'
  }
}

// Wire up buttons once DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const registerBtn = document.getElementById("register-passkey")
  if (registerBtn) {
    registerBtn.addEventListener("click", registerPasskey)
  }

  const loginBtn = document.getElementById("passkey-login-btn")
  if (loginBtn) {
    loginBtn.addEventListener("click", (e) => {
      e.preventDefault()
      authenticateWithPasskey()
    })
  }

  // Account-page only: keep the login-page auto-offer honest. The list renders
  // either passkey rows or the "No passkeys registered yet" empty marker
  // (.result-info); it re-renders on load and whenever passkeys change. An
  // empty list means the account holds no passkeys at all, so no device can
  // sign in with one — forget the auto-offer.
  const passkeyList = document.getElementById("passkey-list-container")
  if (passkeyList) {
    passkeyList.addEventListener("htmx:after:swap", () => {
      if (!passkeyList.querySelector(".passkey-row") && passkeyList.querySelector(".result-info")) {
        forgetPasskey()
      }
    })
  }

  // Login-page only: remember the email across visits and auto-offer a passkey.
  const emailInput = document.getElementById("email")
  const loginForm = document.querySelector('form[hx-post="/api/user/login"]')
  if (emailInput && loginForm) {
    // Record a successful password sign-in. Every successful outcome (session,
    // 2FA, or password-upgrade) returns an HX-Redirect; failures do not.
    loginForm.addEventListener("htmx:after:request", (e) => {
      // HTMX 4 uses fetch (no XHR): the event detail carries `ctx`, and the raw
      // Response's headers expose HX-Redirect via the standard Headers.get().
      const headers = e.detail && e.detail.ctx && e.detail.ctx.response && e.detail.ctx.response.raw && e.detail.ctx.response.raw.headers
      if (headers && headers.get("HX-Redirect")) {
        rememberLogin(emailInput.value.trim(), false)
      }
    })

    // Don't auto-offer a passkey right after a deliberate logout (the logout
    // endpoint redirects here with ?code=logout_success); the email is still
    // pre-filled and the manual button still works.
    const justLoggedOut = new URLSearchParams(window.location.search).get("code") === "logout_success"

    const last = readLastLogin()
    if (last && last.email) {
      if (!emailInput.value) emailInput.value = last.email
      // If a passkey was used for this email on this device, offer it straight
      // away. A failed auto-offer forgets the passkey and falls back to the
      // form silently (see authenticateWithPasskey), so a removed passkey
      // stops prompting instead of nagging on every visit.
      if (last.usedPasskey && !justLoggedOut) authenticateWithPasskey(true)
    }
  }
})
