CREATE TABLE public.passkeys (
    passkey_uuid STRING NOT NULL,
    user_uuid STRING NOT NULL,
    credential_id STRING NOT NULL,
    public_key STRING NOT NULL,
    counter INT8 NOT NULL DEFAULT 0,
    transports STRING[] NULL,
    passkey_name STRING NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP():::TIMESTAMP,
    last_used_at TIMESTAMP NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT passkeys_pkey PRIMARY KEY (passkey_uuid ASC),
    CONSTRAINT passkeys_credential_id_unique UNIQUE (credential_id),
    CONSTRAINT passkeys_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
    INDEX idx_passkeys_user_uuid (user_uuid ASC),
    INDEX idx_passkeys_credential_id (credential_id ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
