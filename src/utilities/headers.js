/**
 * Parses a cookie string and returns the value of a specific cookie.
 * Example: getCookie(context.request.headers.get("Cookie"), "session_token")
 * @param {string | null} cookieString - The full cookie string from the request headers.
 * @param {string} cookieName - The name of the cookie to find.
 * @returns {string | null} The value of the cookie, or null if not found.
 */
export async function getCookie(cookieString, cookieName) {
  if (!cookieString) {
    return null
  }
  const cookies = cookieString.split(";")
  for (let cookie of cookies) {
    const [name, value] = cookie.trim().split("=")
    if (name === cookieName) {
      return decodeURIComponent(value)
    }
  }
  return null
}

/**
 * Parses the User-Agent string from the request headers and returns a human-readable format.
 * Example: parseUserAgent(context.request.headers.get("User-Agent"))
 * @param {string | null} userAgentString - The User-Agent string from the request headers.
 * @returns {string} A human-readable string describing the browser and OS, or "N/A" if not available.
 */
export function parseUserAgent(userAgentString) {
  if (!userAgentString) return "N/A"

  let browser = "Unknown Browser"
  let os = "Unknown OS"

  // Browser detection — order matters: many UAs contain multiple of these tokens.
  // Chrome UAs include "Safari/" (and Chromium-derived browsers include "Chrome/"),
  // so the more-specific brand must be checked before the more-generic one. Current
  // order narrows from most-specific to most-generic: dedicated builds (Firefox,
  // Samsung, Opera) → Chromium derivatives (Edge) → Chrome → bare Safari.
  if (userAgentString.includes("Firefox/")) browser = "Firefox"
  else if (userAgentString.includes("SamsungBrowser/"))
    browser = "Samsung Browser"
  else if (
    userAgentString.includes("Opera/") ||
    userAgentString.includes("OPR/")
  )
    browser = "Opera"
  else if (userAgentString.includes("Edge/")) browser = "Edge (Legacy)"
  else if (userAgentString.includes("Edg/")) browser = "Edge (Chromium)"
  else if (userAgentString.includes("Chrome/")) browser = "Chrome"
  else if (userAgentString.includes("Safari/")) browser = "Safari"

  // OS detection
  if (userAgentString.includes("Windows NT 10.0")) os = "Windows 10/11"
  else if (userAgentString.includes("Windows NT 6.3")) os = "Windows 8.1"
  else if (userAgentString.includes("Windows NT 6.2")) os = "Windows 8"
  else if (userAgentString.includes("Windows NT 6.1")) os = "Windows 7"
  else if (userAgentString.includes("Windows NT 6.0")) os = "Windows Vista"
  else if (userAgentString.includes("Windows NT 5.1")) os = "Windows XP"
  else if (userAgentString.includes("Macintosh; Intel Mac OS X")) os = "macOS"
  else if (userAgentString.includes("Android")) os = "Android"
  else if (
    userAgentString.includes("iPhone") ||
    userAgentString.includes("iPad")
  )
    os = "iOS"
  else if (userAgentString.includes("Linux")) os = "Linux"

  if (browser !== "Unknown Browser" && os !== "Unknown OS") {
    return `${browser} on ${os}`
  } else if (browser !== "Unknown Browser") {
    return browser
  } else if (os !== "Unknown OS") {
    return os
  }

  // Fallback for less common UAs, return a shortened version or N/A
  const maxLength = 30 // Max length for unknown UAs
  return userAgentString.length > maxLength
    ? userAgentString.substring(0, maxLength) + "..."
    : userAgentString
}
