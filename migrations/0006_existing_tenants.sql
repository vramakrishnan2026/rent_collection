-- Tenants who lived here before the app: the real move-in date is kept, but rent is only
-- charged from bill_from (e.g. 1 Dec 2026), at the rent entered (their current rent).
-- next_increase_on: the owner-entered date of the next 5% increase (then every 11 months).
ALTER TABLE tenancies ADD COLUMN bill_from TEXT;
ALTER TABLE tenancies ADD COLUMN next_increase_on TEXT;
