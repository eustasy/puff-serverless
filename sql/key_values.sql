CREATE TABLE public.key_values (
  user_uuid STRING NOT NULL,
  kv_key STRING NOT NULL,
  kv_value STRING NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  CONSTRAINT key_values_pkey PRIMARY KEY (user_uuid ASC, kv_key ASC),
  CONSTRAINT key_values_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
