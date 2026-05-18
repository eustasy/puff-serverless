CREATE TABLE public.secrets (
  secret_uuid STRING NOT NULL,
  user_uuid STRING NOT NULL,
  secret_type STRING NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  secret_name STRING NULL,
  secret_created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  secret_last_used TIMESTAMP NULL,
  secret_value STRING NOT NULL,
  CONSTRAINT secrets_pkey PRIMARY KEY (secret_uuid ASC),
  CONSTRAINT secrets_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
  INDEX idx_secrets_user_uuid_secret_type_is_enabled (user_uuid, secret_type, is_enabled ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION