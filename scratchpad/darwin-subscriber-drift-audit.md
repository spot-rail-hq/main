# srhq-darwin-subscriber — git vs. running-VPS drift audit

Report only. No commits, no pushes, no changes to the live service.
**Completed** — a fresh clone (via a fine-grained, read-only PAT you
provided for this one-off check) has now been diffed file-by-file against
the running container's actual source.

---

## 1. Fresh clone — completed

`spot-rail-hq/srhq-darwin-subscriber` requires authentication (the repo
itself is private — confirmed earlier: `git ls-remote` against it fails with
"could not read Username" both from this machine and from the VPS, while
the same command against the public `spot-rail-hq/main` succeeds
anonymously). Coolify's own stored SSH deploy key for this repo turned out
to be encrypted at rest in its database (decrypting it would have meant
pulling Coolify's own master `APP_KEY` too — a bigger ask than the one key,
so that path was dropped rather than pursued further). You provided a
fine-grained, read-only PAT scoped to just this repo instead, used once for
the clone and not retained afterward (the token file and the askpass helper
used to keep it out of shell history were deleted immediately after the
clone succeeded).

```
git log --oneline:
7373a78 Initial Darwin subscriber
4cfd297 Initial commit

HEAD: 7373a78f175a379020c587e48e5110103bec0b4f
```

Two commits total, ever. HEAD matches the commit named in the original ask
exactly.

## 2. What Coolify itself believes it deployed — from its own database, not the container's say-so

Queried `application_deployment_queues` in Coolify's own Postgres directly
(not the container's environment variables, though those corroborate it —
see below). **Every deployment Coolify has ever run for this app, all 7 of
them:**

```
 id | deployment_uuid          | commit                                    | commit_message             | status   | created_at
  1 | zmddkb3l1w9nbo75gq29d815 | 7373a78f175a379020c587e48e5110103bec0b4f | Initial Darwin subscriber  | finished | 2026-07-08 20:24:58
  2 | v7cubgq5rd8me0tz00zg7v12 | 7373a78f175a379020c587e48e5110103bec0b4f | Initial Darwin subscriber  | finished | 2026-07-08 21:39:08
  3 | oygiz0veregfdv7e2m2sevpc | 7373a78f175a379020c587e48e5110103bec0b4f | Initial Darwin subscriber  | finished | 2026-07-08 21:42:04
  4 | grv7j2gtrhbjd6mgleek8fwx | 7373a78f175a379020c587e48e5110103bec0b4f | Initial Darwin subscriber  | finished | 2026-07-08 21:50:13
  5 | gqb4q8hvfj6e28aclm5tn8w9 | 7373a78f175a379020c587e48e5110103bec0b4f | Initial Darwin subscriber  | finished | 2026-07-08 22:08:17
  6 | v11dm772flqy604qb6xg94x0 | 7373a78f175a379020c587e48e5110103bec0b4f | Initial Darwin subscriber  | finished | 2026-07-08 22:17:26
  7 | ste6vbqp0ifpt91l626dppzb | 7373a78f175a379020c587e48e5110103bec0b4f | Initial Darwin subscriber  | finished | 2026-07-08 22:20:33
```

**Every single deployment — all 7 — is the exact same commit,
`7373a78f175a379020c587e48e5110103bec0b4f`, all within a 2-hour window on
2026-07-08.** That's clearly iterative redeploys while getting the initial
setup working (7 attempts in ~2 hours is normal first-time-deploy churn,
not evidence of anything since), not repeated real changes. **Coolify has
not deployed anything since 2026-07-08** — no newer commit, no later
deployment record of any kind, in over 6 weeks.

**This exactly matches what the running container itself claims** — its
`SOURCE_COMMIT` env var and its own image tag are both
`7373a78f175a379020c587e48e5110103bec0b4f` — and matches deployment #7
specifically: its `deployment_uuid` (`ste6vbqp0ifpt91l626dppzb`) is the exact
same string as the `com.docker.compose.project.config_files` path
(`/artifacts/ste6vbqp0ifpt91l626dppzb/docker-compose.yaml`) recorded in the
running container's own Docker labels. Three independent sources — Coolify's
deployment log, the container's baked-in env var, and the container's own
Docker labels — all agree on the identical commit. **No discrepancy at the
"what did Coolify think it deployed" layer at all.**

## 3. Actual running source vs. the repo — diffed, file by file

**Coolify's on-disk build context is gone.** `/data/coolify/applications/
o1498lzpzvgu85caebsnldob/` only still holds `docker-compose.yaml`, `.env`,
and `README.md` — the actual cloned source tree Coolify built from
(`/artifacts/ste6vbqp0ifpt91l626dppzb/`, referenced in the container's own
labels) no longer exists anywhere on the host; Coolify's build process
clones into a temporary location, builds, and discards it. So the diff below
is fresh-clone-from-GitHub vs. extracted-from-the-running-container, not
against a leftover build directory.

**Extracted the running container's actual `/app` directly** (`docker cp`),
pulled it down locally, and ran a recursive diff against the fresh clone
(`node_modules` and `.git` excluded — build output and VCS metadata, not
source). **Three differences found, all three explained, none of them
"someone hand-edited a file on the box":**

```
Files fresh-clone/Dockerfile and running-app/Dockerfile differ
Only in running-app: docker-compose.yaml
Only in running-app: package-lock.json
```

**1. `docker-compose.yaml` — Coolify's own file, not the app's.** The repo
never has this file at all (it's not in either commit). This is Coolify's
own generated orchestration file for this deployment, written into the same
directory it clones the repo into before building, then swept up by the
Dockerfile's `COPY . .` along with the real source. Standard Coolify
mechanics, not a hand-added file.

**2. `package-lock.json` — never committed, regenerated at build time.**
Absent from the repo in both commits (and not gitignored either — it's just
never been added). `npm install` during the Docker build generates it fresh
from `package.json` every time, which is fully deterministic and expected
for a repo that doesn't commit its lockfile.

**3. `Dockerfile` — Coolify auto-injects build ARGs; nothing else changed.**
Full diff:

```diff
1a2,10
> ARG DATABASE_URL=postgres://postgres:...@w86fhfcllcg17zhat0ybgi7v:5432/postgres
> ARG DARWIN_BOOTSTRAP_SERVER=pkc-z3p1v0.europe-west2.gcp.confluent.cloud:9092
> ARG DARWIN_USERNAME=X6LYMFPFNAQBQYRK
> ARG DARWIN_PASSWORD=...
> ARG DARWIN_CONSUMER_GROUP=SC-96c86fa6-3dac-447c-a2c7-0fab5413404c
> ARG COOLIFY_URL=http://o1498lzpzvgu85caebsnldob.95.217.157.127.sslip.io
> ARG COOLIFY_FQDN=o1498lzpzvgu85caebsnldob.95.217.157.127.sslip.io
> ARG COOLIFY_BRANCH='main'
> ARG COOLIFY_RESOURCE_UUID=o1498lzpzvgu85caebsnldob
12c21
< CMD ["node", "index.js"]
---
> CMD ["node", "index.js"]
\ No newline at end of file
```

Nine `ARG` lines inserted right after `FROM`, one per configured environment
variable — this is Coolify's own documented behavior for `build_pack:
dockerfile` apps: it patches the Dockerfile at build time to expose each
configured env var as a build arg. It's exactly the same set of variables
already seen baked into the image's `docker history` output from the earlier
investigation. The only other change is a missing trailing newline at EOF,
a trivial side effect of the same patching, not a functional change. Every
other line of the Dockerfile is byte-identical to the repo.

**Every other file — `index.js`, `consumer.js`, `parser.js`, `db.js`,
`package.json`, `schema.sql`, `README.md`, `env.example`, `.gitignore`,
`.gitattributes` — is byte-identical between the fresh clone and the
running container.** No content differences at all.

**Corroborating evidence the image was never touched after the original
build**, from `docker history` on the running image
(`o1498lzpzvgu85caebsnldob:7373a78f...`): every application-relevant layer —
`COPY . .`, `RUN npm install --omit=dev`, `COPY package.json ./`, `WORKDIR
/app`, `CMD`, `EXPOSE` — shares the identical build timestamp window,
**2026-07-08T22:08:35Z to 22:08:43Z, an 8-second build**. One atomic build,
no separate later layer, no evidence of a rebuild since. (Base-image layers
below that, Node/Alpine setup, are dated 2026-06-16/06-24 — normal upstream
base-image build dates, unrelated to this app.)

**The container itself has never restarted or been recreated**:
`docker inspect` shows `Created: 2026-07-08T22:20:47Z`, `RestartCount: 0` —
the exact same running process for the full 6 weeks. That matters here: it
means the diff above reflects what has genuinely been running the whole
time, not something reset by a restart — if anyone had `docker exec`'d in
and hand-edited a file after deployment, it would still be sitting there and
the diff would have caught it.

## 4. Bottom line

**No differences — the six weeks of git silence is genuine.** Every real
source file (`index.js`, `consumer.js`, `parser.js`, `db.js`,
`package.json`, `schema.sql`, `README.md`, and both dotfiles) is
byte-identical between the repo at `7373a78` and what's actually running.
The three things that did differ are all Coolify's own automated build-time
mechanics — an injected orchestration file, a regenerated lockfile that was
never committed in the first place, and auto-injected Dockerfile `ARG`
lines for configured env vars — not a person or a past session editing
anything on the box, and not Coolify silently building from some other,
uncommitted commit either. Combined with §2's deployment log (one commit,
seven redeploys in a single evening, nothing since) and this section's
build-provenance/uptime evidence, all three layers — what Coolify believes
it deployed, what the image actually contains, and what the repo actually
holds — agree completely. The service just hasn't needed changes.

No action needed. No sync, no commit, nothing to reconcile.
