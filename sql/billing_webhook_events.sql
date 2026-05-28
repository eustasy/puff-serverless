CREATE TABLE public.billing_webhook_events (
  provider STRING NOT NULL,
  provider_event_id STRING NOT NULL,
  event_type STRING NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT current_timestamp():::TIMESTAMP,
  CONSTRAINT billing_webhook_events_pkey PRIMARY KEY (provider ASC, provider_event_id ASC),
  INDEX idx_billing_webhook_events_received_at (received_at ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
