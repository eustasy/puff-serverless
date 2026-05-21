## Phase 8 — Billing

- [ ] Maybe: optional second database. Old-repo issue [#19](https://github.com/eustasy/puff-server/issues/19) wanted multiple DB connections "by default" to separate domains (it names auth vs. billing). Deferred, no priority — single-DB is the right default, there is no second domain today, and splitting one would lose the cross-table FK / `ON DELETE CASCADE` integrity the schema relies on. Revisit only if a domain with its own scaling, regioning, or compliance boundary actually appears.
