# Deployment Process

All services are deployed through the continuous delivery pipeline. Nobody deploys from a laptop.

## Release schedule

Regular releases go out Tuesday and Thursday at 10:00 UTC. A code freeze applies every Friday after noon and during the last week of December. Emergency fixes may ship at any time with approval from the on-call engineer.

## Pipeline stages

Every merge to the main branch runs unit tests, builds a container image and deploys it to the staging environment. After the smoke tests pass on staging, a release manager promotes the image to production. Production rollouts are canaries: 5 percent of traffic first, then 25 percent, then everything, with ten minutes of observation between steps.

## Rollbacks

If the error rate rises above 2 percent during a canary step, the pipeline aborts the rollout and routes traffic back to the previous image automatically. To roll back a completed release, run the "redeploy previous version" job from the pipeline dashboard. Database migrations must be backward compatible for one release so that a rollback never needs a schema change.

## Feature flags

Risky changes ship dark behind a feature flag and are enabled gradually per customer. Flags older than 90 days must be removed or justified in the weekly engineering review.
