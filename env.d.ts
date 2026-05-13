declare namespace Cloudflare {
  interface Env {
    EMAIL_CHECK_RL: RateLimit
    APP_NAME?: string
    COOKIE_SAMESITE?: string
    SECURE_COOKIE?: string
    SESSION_MAX_AGE_SECONDS?: string
  }
}
