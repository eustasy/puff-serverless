CREATE TABLE public.team_key_values (
    team_uuid STRING NOT NULL,
    kv_key STRING NOT NULL,
    kv_value STRING NOT NULL,
    owner_user_uuid STRING NULL,
    owner_org_uuid STRING NULL,
    owner_app_uuid STRING NULL,
    owner_id STRING NOT NULL AS (COALESCE(owner_user_uuid, owner_org_uuid, owner_app_uuid)) STORED,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP():::TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP():::TIMESTAMP,
    CONSTRAINT team_key_values_pkey PRIMARY KEY (team_uuid ASC, owner_id ASC, kv_key ASC),
    CONSTRAINT team_key_values_subject_fkey FOREIGN KEY (team_uuid) REFERENCES public.teams(team_uuid) ON DELETE CASCADE,
    CONSTRAINT team_key_values_owner_user_fkey FOREIGN KEY (owner_user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
    CONSTRAINT team_key_values_owner_org_fkey FOREIGN KEY (owner_org_uuid) REFERENCES public.organisations(org_uuid) ON DELETE CASCADE,
    CONSTRAINT team_key_values_owner_app_fkey FOREIGN KEY (owner_app_uuid) REFERENCES public.apps(app_uuid) ON DELETE CASCADE,
    CONSTRAINT team_key_values_one_owner CHECK (
        (owner_user_uuid IS NOT NULL)::INT + (owner_org_uuid IS NOT NULL)::INT + (owner_app_uuid IS NOT NULL)::INT = 1
    ),
    INDEX idx_team_key_values_owner_user (owner_user_uuid ASC),
    INDEX idx_team_key_values_owner_org (owner_org_uuid ASC),
    INDEX idx_team_key_values_owner_app (owner_app_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
