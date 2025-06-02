CREATE TABLE public.secrets (
  user_uuid STRING NOT NULL,
  secret_type STRING NOT NULL,
  secret_value STRING NOT NULL,
  secret_name STRING NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  secret_created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  secret_last_used TIMESTAMP NULL,
  CONSTRAINT secrets_pkey PRIMARY KEY (user_uuid, secret_type, is_enabled),
  CONSTRAINT secrets_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION