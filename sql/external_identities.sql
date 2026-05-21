CREATE TABLE public.external_identities (
  user_uuid STRING NOT NULL,
  provider STRING NOT NULL,
  provider_user_id STRING NOT NULL,
  email STRING NULL,
  display_name STRING NULL,
  linked_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  last_used_at TIMESTAMP NULL,
  CONSTRAINT external_identities_pkey PRIMARY KEY (provider ASC, provider_user_id ASC),
  CONSTRAINT external_identities_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
  INDEX idx_external_identities_user_uuid (user_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
