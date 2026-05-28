CREATE TABLE public.organisations (
  org_uuid STRING NOT NULL,
  org_name STRING NOT NULL,
  org_active BOOLEAN NOT NULL DEFAULT TRUE,
  org_locale STRING NULL,
  org_created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  org_created_by STRING NULL,
  CONSTRAINT organisations_pkey PRIMARY KEY (org_uuid ASC),
  CONSTRAINT organisations_org_created_by_fkey FOREIGN KEY (org_created_by) REFERENCES public.users(user_uuid) ON DELETE SET NULL
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION