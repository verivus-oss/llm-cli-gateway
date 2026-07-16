-- A Kit provider can echo the full compiled instruction context. This output
-- privacy migration removes raw provider output, errors, arguments, and API
-- payloads from existing Kit rows. Migration 014 separately retires the
-- provider-native continuation handles that earlier versions stored in the
-- narrow terminal-metadata field.

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS kit_terminal_metadata_json TEXT;

UPDATE jobs
SET args_json = '["[personal-config-kit arguments redacted]"]',
    stdout = '',
    stderr = '',
    payload_json = NULL,
    -- Non-terminal rows can already contain a provider error. Keep that raw
    -- material out of the migrated store while preserving their lifecycle
    -- status for the normal runner or recovery path.
    error = CASE WHEN status IN ('queued', 'running', 'completed') THEN NULL
                 ELSE 'Personal Agent Config Kit provider execution failed; detailed output is withheld'
            END
WHERE kit_execution_json IS NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (11, '011_personal_config_kit_output_privacy')
ON CONFLICT (version) DO NOTHING;
