# Netlify compute optimization

## Evidence supplied on October 10, 2026

The account's current billing-period screenshots show:

- Functions compute: **209.6 credits / 20.96 GB-hours**.
- Web requests: **8.5 credits / 42,516 requests**.
- Bandwidth: **4 credits / 0.2 GB**.
- Production deployments, AI, preview servers, and database compute: **0 credits**.
- Total: **222.1 credits**, leaving **77.9** of the monthly 300-credit allowance.
- Staff keep screens open approximately **5 p.m.–3 a.m. (10 hours)**.
- The owner confirmed there is no external scheduler or uptime service calling
  the application; Supabase is the only connected backend service.

Functions account for approximately **94.4%** of the credits consumed. This
confirms the billing category, but does not identify the slowest or most frequently
invoked endpoint. Billing-period dates and endpoint-level production measurements
were not available. A monthly projection would therefore be speculative.

Netlify measures functions by allocated memory multiplied by execution duration,
including time spent awaiting database responses. Next.js API routes and dynamic
server rendering run in Netlify Functions. Idle open browser tabs do not consume
function compute by themselves; requests from those tabs do.

Sources: [Netlify functions billing](https://docs.netlify.com/build/functions/usage-and-billing/)
and [Next.js on Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/).

## Implemented changes

1. **Coalesce automatic queue refreshes.** Kitchen, bartender, waiter, order board,
   active tabs, and the alternative draft-order hook previously made a full-list
   request per database event. Events within a 100 ms window now share a refresh.
   Events received during an automatic refresh schedule one follow-up, preventing
   the final change from being missed. Continuous events cannot indefinitely
   postpone the first refresh. Initial loads and explicit actions remain immediate.
   Every per-item station notification and acknowledgment is retained.
2. **Batch order-board metadata.** Previously, loading a board with N tabs made
   one order query plus N sequential session queries that also fetched nested
   orders and items. It now uses one order query and one metadata query containing
   only `id`, `session_number`, `status`, and `opened_at`. Order grouping, amounts,
   sorting, filters, and missing-session fallbacks are retained.
3. **Batch confirmation stock reads.** Confirmation now reads all requested
   products' current stock in one fresh query. Existing per-item availability
   results are retained, missing products/query failures block confirmation,
   and subsequent confirmations read stock again. Inventory mutations are unchanged.
4. **Reuse routing metadata.** Regular order items already include server-loaded
   product/category data. Kitchen routing now reuses it when complete and matched
   to the product ID. Incomplete metadata keeps the existing database lookup.
   Package expansion, station destinations, notes, and routing fallbacks are retained.
5. **Use automatic sidebar prefetching.** Replace forced full prefetches with
   Next.js's default behavior. This avoids forcing complete renders of every
   linked dynamic page merely because its sidebar link is visible. Navigation
   destinations and permissions are unchanged; uncached dynamic navigation may
   need to load its data when clicked.

For a burst of ten item events occurring before the refresh starts, the automatic
refresh count falls from ten to one. Ten requested products require one stock
lookup instead of ten. These are reductions on those code paths, **not measured
percentage savings for the entire account**.

The five-second order acknowledgment timer and the IndexedDB/BroadcastChannel
customer monitor are browser-local. They do not cause Netlify function requests.
The happy-hour indicator has a minute-based API timer, but no component currently
imports it; it was not changed as a presumed production cost source.

## Verification and production follow-up

Run `npm run test:usage` for deterministic regression tests covering refresh
bursts, in-flight updates, cleanup, failures, board responses, stock queries,
and routing. Database dependencies are mocked: these tests never change live data.

All 12 regression tests passed. The production build completed with a Windows
standalone file-tracing warning for `page_client-reference-manifest.js`.
The full type-check remains blocked by existing syntax errors in
`scripts/diagnose-user-state.ts`; comparing source-only diagnostics before and
after these changes found no additional errors. The repository's lint command
requires an ESLint configuration; explicit lint checks on the changed files passed.

After deployment, compare function GB-hours per operating day with similar
transaction volume, excluding deployment credits. The credits already consumed
will not decrease. One successful production deployment consumes 15 credits.

If compute remains high, inspect function invocation durations and endpoint
frequencies in Netlify's available function logs/metrics. Check especially order
creation/confirmation, station queue reads, and order-board reads. Then investigate
database/network latency and repeated requests on the identified endpoints.
Do not infer an invocation count from the 42,516 total web requests: that number
also includes static assets and other traffic.

No schema migration, pricing-plan change, or production deployment is required to
review these changes. A deployment is required for them to affect the hosted app.

## Production build guard repair

The optimization PR's Netlify preview passed, but its production merge was
canceled during initialization by the existing custom ignore command. Netlify
reported `User-specified ignore command returned exit code 0`. On a fresh-cache
build, Netlify sets `CACHED_COMMIT_REF` equal to `COMMIT_REF`, so the old diff
incorrectly concluded that no release needed publishing.

The ignore command now uses a dependency-free Node.js helper. Production builds
always proceed. Previews retain documentation-only skipping when two distinct,
valid commit references are available; missing/equal references and Git failures
proceed with the build. Six regression tests cover these decisions. Production
documentation-only commits will also build and can consume deployment credits.
