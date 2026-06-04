CREATE TABLE public.billing_customers (
    org_uuid STRING NOT NULL,
    provider STRING NOT NULL,
    provider_customer_id STRING NOT NULL,
    default_payment_method_id STRING NULL,
    tax_id STRING NULL,
    billing_email STRING NULL,
    synced_email STRING NULL,
    CONSTRAINT billing_customers_pkey PRIMARY KEY (org_uuid ASC),
    CONSTRAINT billing_customers_org_uuid_fkey FOREIGN KEY (org_uuid) REFERENCES public.organisations(org_uuid) ON DELETE CASCADE,
    CONSTRAINT billing_customers_provider_customer_id_unique UNIQUE (provider_customer_id)
) LOCALITY REGIONAL BY TABLE IN PRIMARY REGION
