# Email event time AI fallback

Approved scope: use AI to recover an explicitly written transaction time when the deterministic bank reader cannot recognize it. Categories remain independently reviewable.

- Extend the existing consent-gated, metered email suggestion call with event date, local 24-hour time and an exact transaction excerpt.
- Validate the excerpt against the source text, date and clock; reject invented quotes, impossible dates, ambiguous timestamps, email headers, support hours and due dates.
- Keep deterministic time authoritative. Reuse one AI request for enrichment and time extraction.
- Apply the fallback when reviewing pending legacy analyses with missing time. Preserve immutable stored facts: legacy repairs are response projections, not changes to the captured record.
- Both web and mobile use the authenticated web analysis endpoint. No financial posting or schema change is required.
- Verify provider failure, consent, quotas, deterministic precedence, and legacy repair with synthetic notices before release.

Legacy analyses whose captured time is null may require another metered request on a later analysis because captured facts cannot be updated. A separately persisted reviewed suggestion can be considered later.
