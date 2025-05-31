CREATE TABLE public.sessions (
  user_uuid STRING NOT NULL,
  session_id STRING NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  expires_at TIMESTAMP NULL,
  user_agent STRING NULL,
  ip_address STRING NULL,
  CONSTRAINT sessions_pkey PRIMARY KEY (session_id ASC),
  CONSTRAINT sessions_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid),
  INDEX idx_sessions_user_uuid (user_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION