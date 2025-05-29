CREATE TABLE public.sessions (
  session_id STRING NOT NULL,
  user_uuid STRING NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  user_agent STRING NULL,
  ip_address STRING NULL,
  CONSTRAINT sessions_pkey PRIMARY KEY (session_id ASC),
  CONSTRAINT sessions_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES public.users(user_uuid)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION