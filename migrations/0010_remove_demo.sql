-- The demo copy (13 Nov 2026) was replaced the same day by PIN sign-in on the real sign-in page.
-- These two settings were only used by the demo.
DELETE FROM settings WHERE key IN ('demo_access', 'database_marker');
