CREATE TABLE public.usage_rollups (
  app_uuid STRING NOT NULL,
  org_uuid STRING NOT NULL,
  metric STRING NOT NULL,
  day DATE NOT NULL,
  quantity DECIMAL NOT NULL,
  synced_at TIMESTAMP NULL,
  CONSTRAINT usage_rollups_pkey PRIMARY KEY (app_uuid ASC, org_uuid ASC, metric ASC, day ASC),
  CONSTRAINT usage_rollups_app_uuid_fkey FOREIGN KEY (app_uuid) REFERENCES public.apps(app_uuid) ON DELETE CASCADE,
  CONSTRAINT usage_rollups_org_uuid_fkey FOREIGN KEY (org_uuid) REFERENCES public.organisations(org_uuid) ON DELETE CASCADE,
  INDEX idx_usage_rollups_org_uuid (org_uuid ASC),
  INDEX idx_usage_rollups_day (day ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
