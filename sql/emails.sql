CREATE TABLE public.emails (
  user_uuid STRING NOT NULL,
  email_address STRING NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMP NULL,
  CONSTRAINT emails_pkey PRIMARY KEY (email_address ASC),
  CONSTRAINT emails_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid),
  INDEX idx_emails_user_uuid_is_primary (user_uuid, is_primary ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION