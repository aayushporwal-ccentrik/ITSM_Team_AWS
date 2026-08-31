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
// Selection is env-var only. Local dev leaves AUTH_PROVIDER unset; the AWS
// deployment sets AUTH_PROVIDER=cognito in /etc/itsm/itsm.env. Flipping it
// back to unset + restarting the service is the rollback.

const PROVIDER = process.env.AUTH_PROVIDER || "local";

if (PROVIDER !== "local" && PROVIDER !== "cognito") {
  throw new Error(`Unknown AUTH_PROVIDER "${PROVIDER}" — expected "local" or "cognito"`);
}

console.log(`[auth] provider: ${PROVIDER}`);

module.exports = PROVIDER === "cognito"
  ? require("./auth/cognito-auth")
  : require("./auth/local-auth");
