/**
 * Validates a display name (organisation, team, etc.). Returns an error
 * message, or null if valid. `requiredMessage` is the full sentence used when
 * the name is missing or empty — callers supply it so the grammar reads
 * naturally for the subject ("An organisation name…" vs "A team name…").
 */
export function validateDisplayName(name: string, requiredMessage: string, maxLength: number): string | null {
  if (typeof name !== "string" || name.trim() === "") {
    return requiredMessage
  }
  if (name.trim().length > maxLength) {
    return `Names cannot be longer than ${maxLength} characters.`
  }
  return null
}
