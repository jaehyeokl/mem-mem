# Retention

Normalized copies grow steadily with the team's activity (tens of megabytes per week for an active team). `main` keeps only the last three months.

Policy (to be implemented by the worker; not automated yet):

1. Once a month, find the `trajectories/<YYYY-MM>/` month directories older than 90 days.
2. Commit that month's contents to the `archive/<YYYY-MM>` branch (create the branch if it does not exist).
3. Make a commit on `main` that deletes that month directory. Put the archive branch name and SHA in the commit message.
4. Keep the matching lines of `ingest/log.jsonl` (the path finds the file again on the archive branch).
5. `inbox/` is not archived (it is small and stays in use as reflection evidence).
