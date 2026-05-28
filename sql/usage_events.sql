CREATE TABLE public.usage_events (
  event_uuid STRING NOT NULL,
  app_uuid STRING NOT NULL,
  org_uuid STRING NOT NULL,
  user_uuid STRING NULL,
  metric STRING NOT NULL,
  quantity DECIMAL NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  idempotency_key STRING NOT NULL,
  CONSTRAINT usage_events_pkey PRIMARY KEY (event_uuid ASC),
  CONSTRAINT usage_events_app_uuid_fkey FOREIGN KEY (app_uuid) REFERENCES public.apps(app_uuid) ON DELETE CASCADE,
  CONSTRAINT usage_events_org_uuid_fkey FOREIGN KEY (org_uuid) REFERENCES public.organisations(org_uuid) ON DELETE CASCADE,
  CONSTRAINT usage_events_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE SET NULL,
  CONSTRAINT usage_events_app_uuid_idempotency_key_unique UNIQUE (app_uuid, idempotency_key),
  INDEX idx_usage_events_app_uuid_org_uuid (app_uuid, org_uuid ASC),
  INDEX idx_usage_events_occurred_at (occurred_at ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
