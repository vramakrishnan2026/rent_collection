-- A UPI QR code made by Razorpay alongside each rent link, for the same amount.
-- The tenant can scan it with any UPI app instead of opening the link.
ALTER TABLE payment_links ADD COLUMN qr_id TEXT;         -- Razorpay QR code id (qr_…)
ALTER TABLE payment_links ADD COLUMN qr_image_url TEXT;  -- picture of the QR code
ALTER TABLE payment_links ADD COLUMN qr_status TEXT;     -- 'active' while it can be paid, then 'closed'
CREATE INDEX IF NOT EXISTS idx_links_qr ON payment_links (qr_id);
