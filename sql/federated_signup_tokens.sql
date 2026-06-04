CREATE TABLE public.federated_signup_tokens (
    token_value STRING NOT NULL,
    provider STRING NOT NULL,
    provider_user_id STRING NOT NULL,
    email STRING NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    display_name STRING NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP():::TIMESTAMP,
    is_used BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT federated_signup_tokens_pkey PRIMARY KEY (token_value ASC),
    INDEX idx_federated_signup_tokens_expires_at (expires_at ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
