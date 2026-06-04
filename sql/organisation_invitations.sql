CREATE TABLE public.organisation_invitations (
    invitation_token STRING NOT NULL,
    org_uuid STRING NOT NULL,
    email_address STRING NOT NULL,
    roles STRING[] NOT NULL,
    invited_by STRING NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP():::TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    is_used BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT organisation_invitations_pkey PRIMARY KEY (invitation_token ASC),
    CONSTRAINT organisation_invitations_org_uuid_fkey FOREIGN KEY (org_uuid) REFERENCES public.organisations(org_uuid) ON DELETE CASCADE,
    CONSTRAINT organisation_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(user_uuid) ON DELETE SET NULL,
    INDEX idx_organisation_invitations_org_uuid (org_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION