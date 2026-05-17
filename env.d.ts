declare namespace Cloudflare {
  interface Env {
    EMAIL_CHECK_RL: RateLimit
    APP_NAME?: string
    APP_URL?: string
    COOKIE_SAMESITE?: string
    SECURE_COOKIE?: string
    SESSION_MAX_AGE_SECONDS?: string
    MAILTRAP_TOKEN?: string
    MAILTRAP_SENDER?: string
    MAILTRAP_SENDER_NAME?: string
    MAILTRAP_API_URL?: string
  }
}
