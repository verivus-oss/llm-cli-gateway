fix(test): the heartbeat clock mock never touched the column it guarded

`last_heartbeat` is written by SQLite via SQLITE_NOW_MS (`julianday('now')`),
not by `Date.now()`, so the `vi.spyOn(Date, "now")` offset added to separate
the two writes had no effect on it. The tell was in the failure itself: a ZERO
difference rather than the 1000ms the offset should have produced.

  expected 1787778683824 to be greater than 1787778683824

The same test also guarded its property loop on that timestamp advancing, so on
a tick where the clock did not move the loop asserted NOTHING and still went
green.

`ageHeartbeat` backdates the row before the baseline, mirroring what expireLease
already does for the lease. No clock is mocked, because neither column reads
one. 6 consecutive runs green; splitting heartbeat back into two transactions
still fails the test, so it catches the defect it exists for.
