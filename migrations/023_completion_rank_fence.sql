-- A completion may be OBSERVED (the process saw the provider terminate) or
-- PRESUMED (the #139 orphan sweep decided a job was dead and wrote a synthetic
-- body). Both land as 'completed' or 'failed', so the recorder could not tell
-- them apart, and the winner was whichever wrote last.
--
-- That is wrong in both directions. When the sweep lands second it overwrites a
-- real answer with a guess, which flight-recorder-port.test.ts has pinned as a
-- known defect ("a revision fence is required rather than optional"). When the
-- sweep lands first, fencing on `status <> 'started'` would discard the real
-- answer instead. Neither first-wins nor last-wins is correct.
--
-- The rank makes the rule authority rather than arrival:
--   0 started, 1 presumed, 2 observed
-- and a completion lands only if its rank is >= the stored rank. Observed beats
-- presumed whichever arrives first; presumed never clobbers observed; two
-- observed completions keep last-write-wins, which is today's behaviour for the
-- one case that was never broken.

ALTER TABLE gateway_metadata
  ADD COLUMN IF NOT EXISTS completion_rank SMALLINT;

-- Existing rows predate the fence. A row already carrying a terminal status was
-- an observed completion as far as anything here can know, and backfilling it
-- to 2 is the safe direction: it cannot be overwritten by a later presumption.
UPDATE gateway_metadata
SET completion_rank = CASE WHEN status = 'started' THEN 0 ELSE 2 END
WHERE completion_rank IS NULL;

ALTER TABLE gateway_metadata
  ALTER COLUMN completion_rank SET DEFAULT 0,
  ALTER COLUMN completion_rank SET NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (23, '023_completion_rank_fence')
ON CONFLICT (version) DO NOTHING;
