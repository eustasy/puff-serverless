CREATE TABLE public.totp_used_codes (
  user_uuid STRING NOT NULL,
  totp_code STRING NOT NULL,
  used_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  CONSTRAINT totp_used_codes_pkey PRIMARY KEY (user_uuid ASC, totp_code ASC),
  CONSTRAINT totp_used_codes_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
  INDEX idx_totp_used_codes_used_at (used_at ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
