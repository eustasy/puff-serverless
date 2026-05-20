CREATE TABLE public.apps (
  app_uuid STRING NOT NULL,
  app_name STRING NOT NULL,
  client_id STRING NOT NULL,
  client_secret STRING NOT NULL,
  redirect_uris STRING[] NOT NULL,
  app_active BOOLEAN NOT NULL DEFAULT TRUE,
  app_created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  CONSTRAINT apps_pkey PRIMARY KEY (app_uuid ASC),
  CONSTRAINT apps_client_id_unique UNIQUE (client_id)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
