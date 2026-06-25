# Deploy

## Normal production deploy

Use the safe deploy script for frontend and Firestore rules:

```bash
npm run deploy
```

This runs:

```bash
firebase deploy --only hosting,firestore:rules
```

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
