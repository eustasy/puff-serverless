CREATE TABLE public.secrets (
  user_uuid STRING NOT NULL,
  secret_type STRING NOT NULL,
  secret_value STRING NOT NULL,
  secret_name STRING NULL,
  secret_enabled INT8 NULL,
  secret_created_at STRING NOT NULL,
  secret_last_used STRING NOT NULL DEFAULT 'never':::STRING,
  rowid INT8 NOT VISIBLE NOT NULL DEFAULT unique_rowid(),
  CONSTRAINT secrets_pkey PRIMARY KEY (rowid ASC),
  CONSTRAINT secrets_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid),
  INDEX idx_tokens_secret_type (secret_type ASC),
  INDEX idx_tokens_secret_value (secret_value ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION