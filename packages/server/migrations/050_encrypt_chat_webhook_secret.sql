-- `chat_channel_configs.webhook_secret` is a bearer credential: any caller who
-- knows it can POST to /api/webhooks/chat/:channel/:secret and inject inbound
-- messages as the platform. It was the one credential in the schema stored in
-- plaintext, next to encrypted siblings, and it was exported in the clear by
-- the logical backup.
--
-- The value cannot be re-encoded here: encryption needs the master key, and
-- migrations run at boot while the instance is still locked. So this migration
-- only adds the ciphertext column; the existing plaintext is carried forward
-- untouched and converted by `backfillChatWebhookSecrets()` on the next unlock,
-- which is the first moment the key exists. Reads prefer the encrypted column
-- and fall back to the legacy one, so a webhook keeps working across the whole
-- window - nothing is invalidated and no platform re-registration is needed.
ALTER TABLE chat_channel_configs ADD COLUMN webhook_secret_encrypted TEXT;

COMMENT ON COLUMN chat_channel_configs.webhook_secret IS
    'DEPRECATED legacy plaintext. Nulled once backfillChatWebhookSecrets() has re-encoded it into webhook_secret_encrypted. Read only as a fallback.';
