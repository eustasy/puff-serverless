CREATE TABLE public.teams (
  team_uuid STRING NOT NULL,
  org_uuid STRING NOT NULL,
  team_name STRING NOT NULL,
  team_created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  CONSTRAINT teams_pkey PRIMARY KEY (team_uuid ASC),
  CONSTRAINT teams_org_uuid_fkey FOREIGN KEY (org_uuid) REFERENCES public.organisations(org_uuid) ON DELETE CASCADE,
  INDEX idx_teams_org_uuid (org_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION