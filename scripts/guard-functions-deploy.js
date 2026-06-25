#!/usr/bin/env node

const allow = process.env.ALLOW_FUNCTIONS_DEPLOY === "1";

if (allow) {
  console.log("Functions deploy explicitly allowed by ALLOW_FUNCTIONS_DEPLOY=1.");
  process.exit(0);
}

console.error(`
Blocked Firebase Functions deploy.

This repository can safely deploy Hosting and Firestore rules, but the local
functions source may not include every function currently deployed in
production. A full "firebase deploy" could delete production functions.

Use this for normal frontend/rules deploys:
  npm run deploy

Only deploy Functions after syncing/auditing the production functions list:
  ALLOW_FUNCTIONS_DEPLOY=1 firebase deploy --only functions
`);

process.exit(1);
