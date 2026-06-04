CREATE TABLE public.organisation_members (
    org_uuid STRING NOT NULL,
    user_uuid STRING NOT NULL,
    role STRING NOT NULL,
    added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP():::TIMESTAMP,
    added_by STRING NULL,
    CONSTRAINT organisation_members_pkey PRIMARY KEY (org_uuid ASC, user_uuid ASC, role ASC),
    CONSTRAINT organisation_members_org_uuid_fkey FOREIGN KEY (org_uuid) REFERENCES public.organisations(org_uuid) ON DELETE CASCADE,
    CONSTRAINT organisation_members_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
    CONSTRAINT organisation_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(user_uuid) ON DELETE SET NULL,
    INDEX idx_organisation_members_user_uuid (user_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION