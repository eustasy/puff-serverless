CREATE TABLE public.team_members (
  team_uuid STRING NOT NULL,
  user_uuid STRING NOT NULL,
  role STRING NOT NULL,
  added_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  added_by STRING NULL,
  CONSTRAINT team_members_pkey PRIMARY KEY (team_uuid ASC, user_uuid ASC, role ASC),
  CONSTRAINT team_members_team_uuid_fkey FOREIGN KEY (team_uuid) REFERENCES public.teams(team_uuid) ON DELETE CASCADE,
  CONSTRAINT team_members_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
  CONSTRAINT team_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(user_uuid) ON DELETE SET NULL,
  INDEX idx_team_members_user_uuid (user_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION