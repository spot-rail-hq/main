# Project notes for Claude

This site (srhq.uk) is hosted on Vercel, deployed automatically from the
`main` branch on GitHub.

## vercel.json is high-risk

A single invalid field in `vercel.json` causes Vercel to silently reject
EVERY future deployment with no visible error in the dashboard — git pushes
just stop producing new deployments. This already happened once (commit
`64faf76`) and cost half a day to diagnose.

If you ever edit `vercel.json`:

- `redirects[].source` (and `rewrites`/`headers` `source`) must be a PATH
  starting with `/` — never a full URL with `https://` or a hostname.
- To redirect/match based on domain (e.g. `www.srhq.uk` vs `srhq.uk`), use
  `"has": [{ "type": "host", "value": "www.srhq.uk" }]` alongside a path
  `source`, not the hostname in `source` itself.
- After committing a `vercel.json` change and the user pushes it, ASK the
  user to check the Vercel "Deployments" tab and confirm a new deployment
  appears and reaches "Ready" — do not assume success just because the push
  worked.
- If a previously-working deploy pipeline suddenly stops producing any new
  deployments (including via Deploy Hooks returning 201/PENDING with
  nothing showing up), check `vercel.json` for validation errors FIRST,
  before investigating account/billing/Git-integration settings.
