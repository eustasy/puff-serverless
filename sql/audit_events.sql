-- Audit log. Append-only by design: no `updated_at`, no DELETE/UPDATE paths
-- from application code. Low-severity rows age out via the hourly cron
-- (see src/cron.ts); `notice` and above are retained indefinitely.
--
-- DELIBERATE: there are NO foreign keys on the uuid columns. An audit row
-- exists precisely to remember that an action happened — losing the link
-- when the referenced user/org/team/app is later deleted would defeat the
-- purpose ("what did this account do before we removed it?"). Reporting
-- code joins back with LEFT JOIN; rows whose target is gone show as
-- deleted, but the uuid (and `target_label` snapshot) is preserved.
CREATE TABLE public.audit_events (
  event_uuid STRING NOT NULL,
  event_type STRING NOT NULL,
  event_severity STRING NOT NULL DEFAULT 'info',
  event_outcome STRING NOT NULL DEFAULT 'success',
  actor_user_uuid STRING NULL,
  actor_ip STRING NULL,
  actor_user_agent STRING NULL,
  target_user_uuid STRING NULL,
  target_org_uuid STRING NULL,
  target_team_uuid STRING NULL,
  target_app_uuid STRING NULL,
  target_label STRING NULL,
  event_metadata STRING NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  CONSTRAINT audit_events_pkey PRIMARY KEY (event_uuid ASC),
  CONSTRAINT audit_events_severity_check CHECK (event_severity IN ('debug', 'info', 'notice', 'warning', 'alert', 'critical')),
  CONSTRAINT audit_events_outcome_check CHECK (event_outcome IN ('success', 'failure', 'attempt')),
  INDEX idx_audit_events_actor_user_created (actor_user_uuid ASC, created_at DESC),
  INDEX idx_audit_events_target_user_created (target_user_uuid ASC, created_at DESC),
  INDEX idx_audit_events_target_org_created (target_org_uuid ASC, created_at DESC),
  INDEX idx_audit_events_type_created (event_type ASC, created_at DESC),
  INDEX idx_audit_events_severity_created (event_severity ASC, created_at ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
