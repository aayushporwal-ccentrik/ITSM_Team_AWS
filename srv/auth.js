"use strict";

// Auth provider selector. CAP loads this file as its auth implementation
// (package.json -> cds.requires.auth.impl), so whatever we export here *is*
// the middleware.
//
//   AUTH_PROVIDER unset / "local"  -> srv/auth/local-auth.js   (email + password + HS256 JWT)
//   AUTH_PROVIDER=cognito          -> srv/auth/cognito-auth.js  (AWS Cognito)
//
// Both providers export the same shape: the middleware function itself, plus
// mountAuthRoutes and sendPasswordSetupEmail as properties. Nothing else in
// the app needs to know which one is active.
//
// Selection: AUTH_PROVIDER env var wins if set (that's what the AWS
// deployment sets in /etc/itsm/itsm.env); otherwise it falls back to the
// active CAP profile's cds.requires.auth.provider (package.json), so local
// dev and hybrid don't need the env var set at all. Flipping AUTH_PROVIDER
// back to unset + restarting the service is still the rollback in prod.
const cds = require("@sap/cds");

const PROVIDER = process.env.AUTH_PROVIDER || cds.env.requires?.auth?.provider || "local";

if (PROVIDER !== "local" && PROVIDER !== "cognito") {
  throw new Error(`Unknown AUTH_PROVIDER "${PROVIDER}" — expected "local" or "cognito"`);
}

console.log(`[auth] provider: ${PROVIDER}`);

module.exports = PROVIDER === "cognito"
  ? require("./auth/cognito-auth")
  : require("./auth/local-auth");
