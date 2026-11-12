-- Move-out settlement: one month's rent kept from the deposit for maintenance.
ALTER TABLE tenancies ADD COLUMN deposit_maintenance INTEGER;
