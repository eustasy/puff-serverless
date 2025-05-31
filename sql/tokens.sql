CREATE TABLE public.tokens (
  user_uuid STRING NOT NULL,
  token_type STRING NOT NULL,
  token_value STRING NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  is_used BOOLEAN NOT NULL DEFAULT FALSE,
  email_address STRING NULL,
  CONSTRAINT tokens_pkey PRIMARY KEY (token_value ASC),
  CONSTRAINT tokens_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
  INDEX idx_tokens_user_uuid (user_uuid, token_type ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION