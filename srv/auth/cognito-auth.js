// AWS Cognito auth provider. Loaded by srv/auth.js when AUTH_PROVIDER=cognito.
//
// Exports the same shape as local-auth.js:
//   module.exports            the CAP auth middleware
//   .mountAuthRoutes()        called from srv/server.js on bootstrap
//   .sendPasswordSetupEmail() called from srv/service.js (admin re-sends an invite)
//   .createUser/.deleteUser/.setUserRoles/.setUserActive
//                             called from srv/service.js to keep Cognito in
//                             step with the ITSM User table. local-auth.js does
//                             not export these, so service.js guards on them.
//
// Cognito owns identity, passwords and group membership. The ITSM User table
// still owns name/email/organization/team and everything the ticket, email,
// scheduler and reminder logic reads. User.cognitoUserId links the two.
//
// Login is proxied through the backend (InitiateAuth) so the UI5 login page is
// unchanged. The Cognito ID token is what the browser then sends on every
// request; it lists the user's groups but carries no "active" role, so the
// browser sends X-Active-Role and the middleware re-checks it against the
// token's groups every time.

"use strict";

// ==================== IMPORTS ====================

const cds = require("@sap/cds");
const crypto = require("crypto");
const express = require("express");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminEnableUserCommand,
  AdminDisableUserCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand
} = require("@aws-sdk/client-cognito-identity-provider");
const { SELECT, UPDATE } = cds.ql;
const { CDS_ROLE_BY_CODE } = require("./roles");

// ==================== CONFIG ====================

const REGION = process.env.COGNITO_REGION;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
// Empty for a public app client (recommended). Only set if the client has a secret.
const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET;

if (!REGION || !USER_POOL_ID || !CLIENT_ID) {
  throw new Error(
    "AUTH_PROVIDER=cognito needs COGNITO_REGION, COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID"
  );
}

const CREDENTIALS_MESSAGE = "Invalid email or password.";
const INACTIVE_MESSAGE = "Your account is inactive. Please contact your administrator.";
const SESSION_MESSAGE = "Your session has expired. Please login again.";
const FORGOT_MESSAGE = "If an account exists for this email, a password reset link has been sent.";
const RESET_EXPIRED_MESSAGE = "This password reset link has expired. Please request a new one.";

// Admin* calls use the default AWS credential chain (env / shared config).
// InitiateAuth, ForgotPassword and ConfirmForgotPassword are unauthenticated
// and need no credentials.
const cognito = new CognitoIdentityProviderClient({ region: REGION });

// Verifies signature (RS256 via JWKS), issuer, audience (= client id),
// expiry and token_use. We use the ID token throughout.
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  clientId: CLIENT_ID,
  tokenUse: "id"
});

// Preload the JWKS at startup so the first login doesn't pay the fetch, and a
// wrong pool id fails loudly now instead of on the first request.
verifier.hydrate().then(
  () => console.log("[auth] cognito JWKS loaded"),
  (error) => console.error("[auth] cognito JWKS preload failed:", error.message)
);

// ==================== COGNITO HELPERS ====================

// Only needed when the app client was created with a secret.
function secretHash(username) {
  if (!CLIENT_SECRET) { return undefined; }
  return crypto.createHmac("sha256", CLIENT_SECRET).update(username + CLIENT_ID).digest("base64");
}

// Adds SECRET_HASH to a Cognito auth-parameters object when a secret is set.
function authParams(extra) {
  const params = Object.assign({}, extra);
  const hash = secretHash(params.USERNAME);
  if (hash) { params.SECRET_HASH = hash; }
  return params;
}

// Cognito groups a user may belong to include non-role groups too — keep only
// the four that map to an ITSM role.
function rolesFromGroups(groups) {
  return (groups || []).filter(group => CDS_ROLE_BY_CODE[group]);
}

// Live group membership from Cognito. Used only by setUserRoles (the login
// path reads groups straight off the verified token instead).
async function groupsOf(username) {
  const out = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username
  }));
  return (out.Groups || []).map(group => group.GroupName);
}

// ==================== ITSM USER <-> COGNITO USER MAPPING ====================

// Cognito identifies a user by "sub"; ITSM uses User.userId everywhere else.
// User.cognitoUserId is the link. Cached per sub so a busy request stream
// doesn't hit the DB every time — cleared by forgetUser on role/active change.
const userBySub = new Map();

async function itsmUser(sub, email) {
  if (userBySub.has(sub)) { return userBySub.get(sub); }

  const { User } = cds.entities("itsm.master");
  let user = await SELECT.one.from(User).where({ cognitoUserId: sub });

  // A user created before cognitoUserId existed (or before Cognito linked
  // them) is matched once by email and the sub is written back.
  if (!user && email) {
    user = await SELECT.one.from(User).where({ email });
    if (user) {
      await UPDATE(User).set({ cognitoUserId: sub }).where({ userId: user.userId });
    }
  }

  if (!user) { return null; }

  const entry = { userId: user.userId, email: user.email, name: user.name, isActive: user.isActive };
  userBySub.set(sub, entry);
  return entry;
}

function forgetUser(sub) {
  if (sub) { userBySub.delete(sub); }
}

// ==================== AUTHENTICATION MIDDLEWARE ====================

// <img src> can't send an Authorization header, so logos (not sensitive) are exempt.
const PUBLIC_GET_PATTERNS = [/\/logoContent(\?.*|$)/];

// The role the user is working as right now. X-Active-Role is only honoured if
// that role is actually in the verified token's groups — the browser can't
// grant itself a role it doesn't have.
function activeRole(req, roles) {
  const asked = req.headers["x-active-role"];
  if (asked && roles.includes(asked)) { return asked; }
  return roles.length === 1 ? roles[0] : null;
}

async function cognitoAuth(req, res, next) {
  let payload = null;
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    try {
      payload = await verifier.verify(header.slice(7));
    } catch (error) {
      payload = null;
    }
  }

  if (payload) {
    const roles = rolesFromGroups(payload["cognito:groups"]);
    const role = activeRole(req, roles);
    const user = role ? await itsmUser(payload.sub, payload.email) : null;

    if (user && user.isActive !== false) {
      req.user = new cds.User({ id: user.userId, roles: [CDS_ROLE_BY_CODE[role]].filter(Boolean) });
      req.user.email = user.email;
      req.user.roleCode = role;
      req.user.roleCodes = roles;
      req.user.cognitoSub = payload.sub;
      return next();
    }
  }

  if (req.method === "GET" && PUBLIC_GET_PATTERNS.some(rx => rx.test(req.path))) {
    req.user = new cds.User({ id: "public-asset-reader", roles: [] });
  } else {
    req.user = cds.User.anonymous;
  }
  next();
}

// ==================== LOGIN ====================

async function onLogin(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  let out;
  try {
    out = await cognito.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: authParams({ USERNAME: email, PASSWORD: password })
    }));
  } catch (error) {
    if (error.name === "UserNotConfirmedException" || error.name === "PasswordResetRequiredException") {
      return res.status(403).json({
        message: "Your password needs to be reset. Use 'Forgot Password?' to continue."
      });
    }
    // Client always sees the same generic message. The server log carries the
    // real reason — most NotAuthorizedException is just a wrong password, but
    // the same error name also means SECRET_HASH missing or the auth flow not
    // enabled, so log the message (not just the name) to tell them apart.
    const wrongPassword = error.name === "NotAuthorizedException"
      && /incorrect username or password/i.test(error.message || "");
    if (!wrongPassword) {
      console.error("[auth] Cognito InitiateAuth error:", error.name, "-", error.message);
    }
    return res.status(401).json({ message: CREDENTIALS_MESSAGE });
  }

  // Admin-created users start with a temporary password Cognito forces them to
  // replace before login completes. No token is issued yet.
  if (out.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    return res.json({ authenticated: false, passwordChangeRequired: true, session: out.Session, email });
  }

  return respondWithSession(res, out.AuthenticationResult, email);
}

// Shared by normal login and the initial-password change — both end with a
// Cognito AuthenticationResult.
async function respondWithSession(res, result, email) {
  if (!result || !result.IdToken) {
    return res.status(401).json({ message: CREDENTIALS_MESSAGE });
  }

  const payload = await verifier.verify(result.IdToken);
  const roles = rolesFromGroups(payload["cognito:groups"]);

  if (!roles.length) {
    return res.status(403).json({
      message: "No role is assigned to your account. Please contact your administrator."
    });
  }

  const user = await itsmUser(payload.sub, payload.email);
  if (!user) {
    return res.status(403).json({
      message: "Your account is not set up in ITSM. Please contact your administrator."
    });
  }
  if (user.isActive === false) {
    return res.status(403).json({ message: INACTIVE_MESSAGE });
  }

  const body = {
    authenticated: true,
    user: { id: user.userId, name: user.name, email: user.email },
    requiresRoleSelection: roles.length > 1,
    token: result.IdToken
  };

  if (body.requiresRoleSelection) {
    body.roles = await describeRoles(roles);
  } else {
    body.role = roles[0];
  }

  res.json(body);
}

// ==================== INITIAL PASSWORD ====================

// Completes Cognito's NEW_PASSWORD_REQUIRED challenge for a new user.
async function onSetInitialPassword(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const session = String(req.body.session || "");

  if (password.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }
  if (password !== String(req.body.confirmPassword || "")) {
    return res.status(400).json({ message: "Passwords do not match." });
  }

  let out;
  try {
    out = await cognito.send(new RespondToAuthChallengeCommand({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: CLIENT_ID,
      Session: session,
      ChallengeResponses: authParams({ USERNAME: email, NEW_PASSWORD: password })
    }));
  } catch (error) {
    return res.status(400).json({ message: passwordPolicyMessage(error) });
  }

  return respondWithSession(res, out.AuthenticationResult, email);
}

// ==================== ROLE SELECTION ====================

// Role code -> display name/description for the role selection tiles.
async function describeRoles(roles) {
  const { LookupValue } = cds.entities("itsm.master");
  const lookups = await SELECT.from(LookupValue).where({ lookupType: "ROLE" });
  return roles.map(code => {
    const lookup = lookups.find(item => item.code === code);
    return { code, name: lookup?.name || code, description: lookup?.description || "" };
  });
}

// Pick the working role, or switch it later. No new token — the same ID token
// goes back and the browser changes the X-Active-Role header. The requested
// role is checked against the token's own groups, never against the frontend.
async function onSelectRole(req, res) {
  const header = req.headers.authorization || "";
  let payload = null;
  if (header.startsWith("Bearer ")) {
    try {
      payload = await verifier.verify(header.slice(7));
    } catch (error) {
      payload = null;
    }
  }
  if (!payload) {
    return res.status(401).json({ message: SESSION_MESSAGE });
  }

  const role = String(req.body.role || "");
  const roles = rolesFromGroups(payload["cognito:groups"]);
  if (!roles.includes(role)) {
    return res.status(403).json({ message: "You are not authorized for this role." });
  }

  const user = await itsmUser(payload.sub, payload.email);
  if (!user || user.isActive === false) {
    return res.status(403).json({ message: INACTIVE_MESSAGE });
  }

  res.json({
    token: header.slice(7),
    role,
    user: { id: user.userId, name: user.name, email: user.email }
  });
}

// ==================== PASSWORD RESET ====================

// Cognito emails a code (not a link). Same generic reply whether or not the
// address exists.
async function onForgotPassword(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();

  if (email) {
    try {
      await cognito.send(new ForgotPasswordCommand({
        ClientId: CLIENT_ID,
        Username: email,
        SecretHash: secretHash(email)
      }));
    } catch (error) {
      console.error("Cognito forgot-password failed:", error.name);
    }
  }

  // Constant regardless of whether the account exists (no enumeration leak).
  // Tells the UI to show the code + new-password screen instead of "check your
  // email for a link" — Cognito sends a code, the local provider sends a link.
  res.json({ message: FORGOT_MESSAGE, resetWithCode: true });
}

// Confirms the emailed code. The code alone doesn't say who is resetting, so
// the frontend sends the address it already knows alongside it.
async function onResetPassword(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  const code = String(req.body.token || "");
  const password = String(req.body.password || "");

  if (!email || !code) {
    return res.status(400).json({ message: "Enter the email address and the code from the reset email." });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }
  if (password !== String(req.body.confirmPassword || "")) {
    return res.status(400).json({ message: "Passwords do not match." });
  }

  try {
    await cognito.send(new ConfirmForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
      Password: password,
      SecretHash: secretHash(email)
    }));
  } catch (error) {
    if (error.name === "ExpiredCodeException" || error.name === "CodeMismatchException") {
      return res.status(400).json({ message: RESET_EXPIRED_MESSAGE });
    }
    return res.status(400).json({ message: passwordPolicyMessage(error) });
  }

  res.json({ message: "Password reset successfully." });
}

function passwordPolicyMessage(error) {
  if (error.name === "InvalidPasswordException") {
    return error.message || "Password does not meet the required policy.";
  }
  return "Could not set the password. Please try again.";
}

// ==================== ADMIN -> COGNITO SYNCHRONISATION ====================

// Called from srv/service.js after CREATE Users. ITSM owns the app user;
// Cognito creates the identity and sends the invitation email. Returns the
// Cognito sub so service.js can store it on the User row.
async function createUser(user, roles) {
  const email = String(user.email || "").trim().toLowerCase();

  const out = await cognito.send(new AdminCreateUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: email,
    UserAttributes: [
      { Name: "email", Value: email },
      { Name: "email_verified", Value: "true" },
      { Name: "name", Value: user.name || email }
    ]
  }));

  const sub = (out.User.Attributes || []).find(a => a.Name === "sub")?.Value;

  // Assign the admin-selected roles. If any group add fails, delete the
  // half-created Cognito user so it isn't left in a broken state.
  try {
    for (const role of roles) {
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        GroupName: role
      }));
    }
  } catch (error) {
    await deleteUser(email);
    throw error;
  }

  return sub;
}

// Used for rollback if creation fails midway (and, later, for delete sync).
async function deleteUser(email) {
  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: String(email || "").trim().toLowerCase()
    }));
  } catch (error) {
    console.error("Cognito rollback delete failed:", error.name);
  }
}

// Reconciles Cognito group membership with the exact set of roles the admin
// saved. Idempotent — safe to call with the full desired list every time.
async function setUserRoles(user, roles) {
  const email = String(user.email || "").trim().toLowerCase();
  const current = await groupsOf(email);

  for (const role of roles.filter(r => !current.includes(r))) {
    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      GroupName: role
    }));
  }

  for (const role of rolesFromGroups(current).filter(r => !roles.includes(r))) {
    await cognito.send(new AdminRemoveUserFromGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      GroupName: role
    }));
  }

  forgetUser(user.cognitoUserId);
}

// Enable/disable the Cognito account when the admin toggles isActive. The ITSM
// User row is kept for historical ticket data either way.
async function setUserActive(user, isActive) {
  const email = String(user.email || "").trim().toLowerCase();
  const Command = isActive ? AdminEnableUserCommand : AdminDisableUserCommand;
  await cognito.send(new Command({ UserPoolId: USER_POOL_ID, Username: email }));
  forgetUser(user.cognitoUserId);
}

// Re-send the Cognito invitation. If the user already finished setup, fall
// back to a normal password reset.
async function sendPasswordSetupEmail(user) {
  const email = String(user.email || "").trim().toLowerCase();
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      MessageAction: "RESEND",
      UserAttributes: [{ Name: "email", Value: email }]
    }));
  } catch (error) {
    await cognito.send(new ForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: email,
      SecretHash: secretHash(email)
    }));
  }
}

// ==================== ROUTES ====================

// Keep a thrown handler from leaking a stack trace to the browser.
function guard(handler) {
  return function (req, res) {
    Promise.resolve(handler(req, res)).catch(function (error) {
      console.error("Auth request failed:", error);
      res.status(500).json({ message: "Something went wrong. Please try again." });
    });
  };
}

function mountAuthRoutes(app) {
  const router = express.Router();
  router.use(express.json());
  router.post("/login", guard(onLogin));
  router.post("/select-role", guard(onSelectRole));
  router.post("/forgot-password", guard(onForgotPassword));
  router.post("/reset-password", guard(onResetPassword));
  router.post("/set-initial-password", guard(onSetInitialPassword));
  app.use("/auth", router);
}

// ==================== EXPORTS ====================

module.exports = cognitoAuth;
module.exports.mountAuthRoutes = mountAuthRoutes;
module.exports.sendPasswordSetupEmail = sendPasswordSetupEmail;
module.exports.createUser = createUser;
module.exports.deleteUser = deleteUser;
module.exports.setUserRoles = setUserRoles;
module.exports.setUserActive = setUserActive;
