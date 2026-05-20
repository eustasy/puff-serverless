CREATE TABLE public.oauth_consents (
  user_uuid STRING NOT NULL,
  app_uuid STRING NOT NULL,
  scopes STRING[] NOT NULL,
  granted_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  CONSTRAINT oauth_consents_pkey PRIMARY KEY (user_uuid ASC, app_uuid ASC),
  CONSTRAINT oauth_consents_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
  CONSTRAINT oauth_consents_app_uuid_fkey FOREIGN KEY (app_uuid) REFERENCES public.apps(app_uuid) ON DELETE CASCADE,
  INDEX idx_oauth_consents_app_uuid (app_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
