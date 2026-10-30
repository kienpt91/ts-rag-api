# Backup and Restore

This runbook describes how production databases are backed up and how to recover them.

## Backup schedule

A full snapshot of every production database is taken nightly at 02:00 UTC. Continuous archiving of the write-ahead log allows point-in-time recovery to any second within the last 7 days. Snapshots are kept for 35 days and copied to a second region.

## Restore procedure

1. Create an incident ticket and notify the on-call engineer.
2. Choose the recovery target time and restore the most recent snapshot before it into a new instance.
3. Replay the write-ahead log up to the target time.
4. Verify row counts and run the consistency checks before pointing any application at the new instance.
5. Switch the connection string and monitor error rates for 30 minutes.

Never restore over the live database in place.

## Restore drills

Every quarter the infrastructure team restores last night's snapshot into an isolated environment and records how long it took. The recovery time objective is 4 hours and the recovery point objective is 5 minutes. Drill results are stored in the operations wiki.
