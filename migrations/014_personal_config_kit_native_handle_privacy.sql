-- Provider-native continuation handles are process-local Kit state. Earlier
-- Kit versions retained a validated UUID in terminal job metadata and session
-- JSON. Retire those handles so a gateway restart fails closed and requires a
-- fresh native conversation.

UPDATE jobs
SET kit_terminal_metadata_json = NULL
WHERE kit_execution_json IS NOT NULL
  AND kit_terminal_metadata_json IS NOT NULL;

UPDATE sessions AS session
SET metadata = jsonb_set(
  COALESCE(session.metadata, '{}'::jsonb),
  '{kit}',
  CASE
    WHEN jsonb_typeof(session.metadata -> 'kit' -> 'attempt') = 'object' THEN
      jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(session.metadata -> 'kit', '{}'::jsonb),
            '{nativeSessionId}',
            'null'::jsonb,
            true
          ),
          '{resumeEligible}',
          'false'::jsonb,
          true
        ),
        '{attempt}',
        jsonb_set(
          session.metadata -> 'kit' -> 'attempt',
          '{expectedNativeSessionId}',
          'null'::jsonb,
          true
        ),
        true
      )
    ELSE
      jsonb_set(
        jsonb_set(
          COALESCE(session.metadata -> 'kit', '{}'::jsonb),
          '{nativeSessionId}',
          'null'::jsonb,
          true
        ),
        '{resumeEligible}',
        'false'::jsonb,
        true
      )
  END,
  true
)
WHERE session.metadata ? 'kit'
  AND jsonb_typeof(session.metadata -> 'kit') = 'object'
  AND (
    session.metadata -> 'kit' -> 'nativeSessionId' IS DISTINCT FROM 'null'::jsonb
    OR session.metadata -> 'kit' -> 'resumeEligible' IS DISTINCT FROM 'false'::jsonb
    OR COALESCE(
      session.metadata -> 'kit' -> 'attempt' -> 'expectedNativeSessionId',
      'null'::jsonb
    ) IS DISTINCT FROM 'null'::jsonb
  );

INSERT INTO schema_migrations (version, name)
VALUES (14, '014_personal_config_kit_native_handle_privacy')
ON CONFLICT (version) DO NOTHING;
