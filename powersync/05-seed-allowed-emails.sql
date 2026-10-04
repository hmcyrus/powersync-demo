-- Test 0.7: allowlisted stub OIDC email (idempotent).
INSERT INTO allowed_emails (email) VALUES ('doctor@example.com')
ON CONFLICT (email) DO NOTHING;
