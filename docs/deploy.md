# Deploy

## Normal production deploy

Use the deploy script for frontend and Firestore rules:

```bash
npm run deploy
```

This runs:

```bash
ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only hosting,firestore:rules
```

**Why the variable is there even though no callable is being deployed.** The app has a dynamic
route (`/registro/[slug]`), so Firebase Hosting serves it through a pinned Cloud Function
(`ssrkentrolastmile`). Every hosting deploy therefore includes a functions target, and the
`functions.predeploy` guard fires before it, regardless of which function it is. Without the
variable the deploy fails with "Blocked Firebase Functions deploy" (seen on 2026-09-13; the old
documented command was wrong from the moment that route existed).

It is safe: with `--only hosting` the scope is hosting plus that single SSR function. The other
Functions are not touched, so nothing can be deleted. The guard still protects the case it was
written for — a plain `firebase deploy` from an incomplete checkout.

Do not run plain `firebase deploy` during routine UI or Firestore rules work.

## Why Functions are guarded

The Firebase project has production Functions that may not all be present in
the local `functions/src` source. If a full deploy includes Functions from an
incomplete checkout, Firebase can ask to delete the production Functions that
are missing locally.

For that reason, `firebase.json` runs `scripts/guard-functions-deploy.js` before
any Functions deploy. The guard blocks Functions deploys unless they are
explicitly allowed.

Production Functions seen on 2026-06-25 that were restored into local source:

- `classifyFailedOrder`
- `normalizeAddress`
- `recordDriverCashReceipt`

Keep this list in sync if production gains new Functions outside this repo.

## Intentional Functions deploy

Only do this after auditing `firebase functions:list` against exports in
`functions/src/index.ts` and confirming no production Function would be
deleted:

```bash
ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only functions
```

or:

```bash
npm run deploy:functions
```

If Firebase prompts to delete a Function that should remain in production,
answer no and sync the missing source first.
