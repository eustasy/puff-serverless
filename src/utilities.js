export async function parseUserAgent(userAgentString) {
  if (!userAgentString) return "N/A"

  let browser = "Unknown Browser"
  let os = "Unknown OS"

  // Browser detection
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
