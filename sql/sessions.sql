CREATE TABLE public.sessions (
    user_uuid STRING NOT NULL,
    session_id STRING NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP():::TIMESTAMP,
    expires_at TIMESTAMP NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_accessed_at TIMESTAMP NULL,
    last_accessed_ip STRING NULL,
    user_agent STRING NULL,
    ip_address STRING NULL,
    ip_country STRING NULL,
    CONSTRAINT sessions_pkey PRIMARY KEY (session_id ASC),
    CONSTRAINT sessions_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid) ON DELETE CASCADE,
    INDEX idx_sessions_user_uuid (user_uuid ASC),
    INDEX idx_sessions_expires_at (expires_at ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION