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
    obj.response.attestationObject = bufferToBase64url(
      response.attestationObject
    )
    if (typeof response.getTransports === "function") {
      obj.response.transports = response.getTransports()
    }
  }

  if (response.authenticatorData) {
    obj.response.authenticatorData = bufferToBase64url(
      response.authenticatorData
    )
    obj.response.signature = bufferToBase64url(response.signature)
    if (response.userHandle) {
      obj.response.userHandle = bufferToBase64url(response.userHandle)
    }
  }

  return obj
}

// Registration — called from the register passkey button in account.html
async function registerPasskey() {
  const msgArea = document.getElementById("passkey-message-area")
  if (msgArea) msgArea.innerHTML = ""

  let startData
  try {
    const startRes = await fetch("/api/db/auth/passkeys/register/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
    if (!startRes.ok) {
      throw new Error("Could not start passkey registration.")
    }
    startData = await startRes.json()
  } catch (err) {
    if (msgArea)
      msgArea.innerHTML =
        '<p class="result-negative">Could not start passkey registration. Please try again.</p>'
    return
  }

  let credential
  try {
    credential = await navigator.credentials.create({
      publicKey: prepareCreationOptions(startData.options),
    })
  } catch (err) {
    if (msgArea)
      msgArea.innerHTML =
        '<p class="result-negative">Passkey creation was cancelled or failed.</p>'
    return
  }

  try {
    const completeRes = await fetch("/api/db/auth/passkeys/register/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializeCredential(credential)),
    })
    const html = await completeRes.text()
    if (msgArea) msgArea.innerHTML = html
    if (completeRes.ok) {
      htmx.trigger(document.body, "passkeysChanged")
    }
  } catch (err) {
    if (msgArea)
      msgArea.innerHTML =
        '<p class="result-negative">Failed to complete passkey registration.</p>'
  }
}

// Authentication — called from the passkey login button in login.html
async function authenticateWithPasskey() {
  const resultArea = document.getElementById("passkey-result")
  if (resultArea) resultArea.innerHTML = ""

  const usernameInput = document.getElementById("passkey-username")
  const username = usernameInput ? usernameInput.value.trim() : ""
  if (!username) {
    if (resultArea)
      resultArea.innerHTML =
        '<p class="result-negative">Please enter your username.</p>'
    return
  }

  let options
  try {
    const formData = new FormData()
    formData.append("username", username)
    const startRes = await fetch("/api/db/passkeys/authenticate/start", {
      method: "POST",
      body: formData,
    })
    if (!startRes.ok) {
      throw new Error("Could not start passkey authentication.")
    }
    options = await startRes.json()
  } catch (err) {
    if (resultArea)
      resultArea.innerHTML =
        '<p class="result-negative">Could not start passkey authentication. Please try again.</p>'
    return
  }

  let credential
  try {
    credential = await navigator.credentials.get({
      publicKey: prepareRequestOptions(options),
    })
  } catch (err) {
    if (resultArea)
      resultArea.innerHTML =
        '<p class="result-negative">Passkey authentication was cancelled or failed.</p>'
    return
  }

  try {
    const completeRes = await fetch("/api/db/passkeys/authenticate/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializeCredential(credential)),
    })

    // Handle redirect from HX-Redirect header
    const redirect = completeRes.headers.get("HX-Redirect")
    if (redirect) {
      window.location.href = redirect
      return
    }

    const html = await completeRes.text()
    if (resultArea) resultArea.innerHTML = html
  } catch (err) {
    if (resultArea)
      resultArea.innerHTML =
        '<p class="result-negative">Passkey authentication failed.</p>'
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
})
