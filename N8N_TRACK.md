NammaCity is a citizen-verified civic accountability ledger. n8n runs the two jobs the app cannot do for itself.

**Escalation ladder (daily)**
- A charter deadline binds nobody. The RTI Act 2005 sets a statutory 30-day deadline on a named Public Information Officer, the only clock here with legal force.
- n8n finds reports stuck at `escalated` for 3 days with no RTI and files one: candidates → split → act → record.
- Idempotent, so it never files twice.
- Pressure continues with no browser open.

**Ward scoreboard (weekly)**
- Publishes what a department *claims* it fixed against what a resident *verified with a photograph*.
- Indian civic portals report 93-95% resolution because the accused department closes its own ticket. FixMyStreet, measured independently, is near 34%.

**Why this fits the track**
- **n8n never holds a privileged credential.** The scoreboard calls a Postgres function returning counts only, no IDs, coordinates, photos or numbers, so the public anon key suffices.
- We refused to give a third-party account a service-role key that bypasses every RLS policy just to read numbers. Authorisation stays in the database.
- Both workflows are committed as importable JSON in `n8n/`, auditable without an n8n login.
- Every RTI goes to a sandbox mailbox, never a real officer.
