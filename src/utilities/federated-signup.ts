/** Derives a display-name for a new federated user: prefers display_name, falls back to email local part, then "user". */
export function deriveUsername(
  display_name: string | null,
  email: string | null
): string {
  if (display_name && display_name.trim() !== "") return display_name.trim()
  if (email) {
    const local = email.split("@")[0]
    if (local && local.trim() !== "") return local.trim()
  }
  return "user"
}
