CREATE TABLE public.billing_pricing (
    pricing_uuid STRING NOT NULL,
    app_uuid STRING NOT NULL,
    tier STRING NOT NULL,
    price_cents INT NOT NULL,
    currency STRING NOT NULL,
    billing_interval STRING NOT NULL,
    provider_price_id STRING NOT NULL,
    CONSTRAINT billing_pricing_pkey PRIMARY KEY (pricing_uuid ASC),
    CONSTRAINT billing_pricing_app_uuid_fkey FOREIGN KEY (app_uuid) REFERENCES public.apps(app_uuid) ON DELETE CASCADE,
    CONSTRAINT billing_pricing_app_uuid_tier_unique UNIQUE (app_uuid, tier),
    CONSTRAINT billing_pricing_interval_check CHECK (billing_interval IN ('month', 'year')),
    INDEX idx_billing_pricing_app_uuid (app_uuid ASC)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
