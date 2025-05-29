CREATE TABLE public.emails (
  user_uuid STRING NOT NULL,
  email_address STRING NOT NULL,
  is_primary INT8 NOT NULL DEFAULT 0:::INT8,
  is_verified INT8 NULL DEFAULT 0:::INT8,
  verified_at STRING NULL,
  CONSTRAINT emails_pkey PRIMARY KEY (email_address ASC),
  CONSTRAINT emails_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid),
  INDEX idx_emails_user_uuid (user_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION