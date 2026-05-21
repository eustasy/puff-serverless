CREATE TABLE public.app_floating_sessions (
  app_uuid STRING NOT NULL,
  org_uuid STRING NOT NULL,
  user_uuid STRING NOT NULL,
  heartbeat_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  CONSTRAINT app_floating_sessions_pkey PRIMARY KEY (app_uuid ASC, org_uuid ASC, user_uuid ASC),
  CONSTRAINT app_floating_sessions_app_fkey FOREIGN KEY (app_uuid) REFERENCES public.apps(app_uuid) ON DELETE CASCADE,
  CONSTRAINT app_floating_sessions_org_fkey FOREIGN KEY (org_uuid) REFERENCES public.organisations(org_uuid) ON DELETE CASCADE,
  CONSTRAINT app_floating_sessions_user_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
  INDEX idx_app_floating_sessions_app_org (app_uuid ASC, org_uuid ASC),
  INDEX idx_app_floating_sessions_expires_at (expires_at ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
