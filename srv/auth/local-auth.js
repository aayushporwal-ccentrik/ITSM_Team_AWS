// Everything authentication: JWT, passwords, password-reset tokens, the
// /auth/* endpoints and the CAP auth middleware.
//
// Only three things leave this file (see EXPORTS at the bottom):
//   module.exports          the CAP auth middleware (package.json -> cds.requires.auth.impl)
//   .mountAuthRoutes()      called from srv/server.js on bootstrap
//   .sendPasswordSetupEmail() called from srv/service.js when an admin creates a user

"use strict";

// ==================== IMPORTS ====================

const cds = require("@sap/cds");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { SELECT, INSERT, UPDATE } = cds.ql;
const { buildPasswordSetupEmailTemplate } = require("../email-templates");
const { transporter, sendEmailSafe } = require("../ticket-helpers");
const { themeForUser } = require("../email-theme");
const { CDS_ROLE_BY_CODE } = require("./roles");

// ==================== CONFIG ====================

const ISSUER = process.env.JWT_ISSUER || "itsm";
const AUDIENCE = process.env.JWT_AUDIENCE || "itsm-app";
const EXPIRY = process.env.JWT_ACCESS_TOKEN_EXPIRY || "8h";

// Never hardcode a secret. Without JWT_SECRET we generate a throwaway one so
// local dev still runs — tokens then die on every server restart, which is
// exactly what you want in dev and never acceptable in production.
const SECRET = process.env.JWT_SECRET || (function () {
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is not set");
  }
  console.warn("JWT_SECRET not set — using a random dev secret, logins reset on restart.");
  return crypto.randomBytes(32).toString("hex");
})();

const RESET_TOKEN_HOURS = 24;

// Base URL the UI5 app is served from — set this per environment, the
// default is where cds-serve puts it locally.
const APP_URL = process.env.APP_URL || "http://localhost:4004/webapp";

// Same wording whether or not the email exists, so nobody can probe for
// registered addresses.
const FORGOT_MESSAGE = "If an account exists for this email, a password reset link has been sent.";
const CREDENTIALS_MESSAGE = "Invalid email or password.";
const INACTIVE_MESSAGE = "Your account is inactive. Please contact your administrator.";
const RESET_EXPIRED_MESSAGE = "This password reset link has expired. Please request a new one.";

// ==================== ROLES ====================

// CDS_ROLE_BY_CODE now lives in ./roles.js — shared with the Cognito provider.

// Roles actually usable for login. Falls back to User.role so users seeded
// before UserRole existed still log in.
async function rolesOf(user) {
  const { UserRole } = cds.entities("itsm.master");
  const rows = await SELECT.from(UserRole).where({ userId: user.userId });
  const roles = rows.map(row => row.role).filter(Boolean);
  if (!roles.length && user.role) { roles.push(user.role); }
  return [...new Set(roles)];
}

// Role code -> display name/description for the role selection tiles.
async function describeRoles(roles) {
  const { LookupValue } = cds.entities("itsm.master");
  const lookups = await SELECT.from(LookupValue).where({ lookupType: "ROLE" });
  return roles.map(code => {
    const lookup = lookups.find(l => l.code === code);
    return { code, name: lookup?.name || code, description: lookup?.description || "" };
  });
}

// ==================== JWT ====================

// role = the role the user is currently working as. null right after login
// when they still have to pick one — that token unlocks nothing but
// /auth/select-role.
function signToken(user, role, roles) {
  return jwt.sign(
    { sub: user.userId, email: user.email, name: user.name, role: role || null, roles },
    SECRET,
    { algorithm: "HS256", issuer: ISSUER, audience: AUDIENCE, expiresIn: EXPIRY }
  );
}

function verifyToken(token) {
  return jwt.verify(token, SECRET, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
}

// The request's Bearer token, or null if it is missing, malformed, expired,
// tampered with or signed for someone else.
function readToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) { return null; }
  try {
    return verifyToken(header.slice(7));
  } catch (e) {
    return null;
  }
}

// ==================== PASSWORDS ====================

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash || "");
}

// ==================== PASSWORD RESET ====================

// The raw token goes in the email, only its hash is ever stored.
function newResetToken() {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, hash: hashResetToken(token) };
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Used by both "admin created your account" and "forgot password" — one
// token mechanism, one email.
async function sendPasswordSetupEmail(user, isReset) {
  const { PasswordResetToken } = cds.entities("itsm.master");
  const reset = newResetToken();

  await INSERT.into(PasswordResetToken).entries({
    userId: user.userId,
    tokenHash: reset.hash,
    expiresAt: new Date(Date.now() + RESET_TOKEN_HOURS * 3600 * 1000).toISOString(),
    usedAt: null
  });

  const link = `${APP_URL}/index.html#/reset-password/${reset.token}`;

  // Without SMTP configured there'd be no way to test the flow at all.
  if (!process.env.SMTP_HOST) { console.log(`Password link for ${user.email}: ${link}`); }

  await sendEmailSafe(transporter, {
    from: process.env.MAIL_FROM,
    to: user.email,
    subject: isReset ? "Reset your ITSM password" : "Set up your ITSM password",
    html: buildPasswordSetupEmailTemplate(user, link, isReset, RESET_TOKEN_HOURS, await themeForUser(user.userId))
  });
}

// ==================== LOGIN & ROLE SELECTION ====================

async function onLogin(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  const { User } = cds.entities("itsm.master");
  const user = await SELECT.one.from(User).where({ email });

  // Same 401 for unknown email, wrong password and no password set yet —
  // never say which one it was.
  if (!user || !user.passwordHash || !(await comparePassword(password, user.passwordHash))) {
    return res.status(401).json({ message: CREDENTIALS_MESSAGE });
  }

  if (!user.isActive) {
    return res.status(403).json({ message: INACTIVE_MESSAGE });
  }

  const roles = await rolesOf(user);
  if (!roles.length) {
    return res.status(403).json({ message: "No role is assigned to your account. Please contact your administrator." });
  }

  const body = {
    authenticated: true,
    user: { id: user.userId, name: user.name, email: user.email },
    requiresRoleSelection: roles.length > 1
  };

  if (body.requiresRoleSelection) {
    // Role is still null on this token — it unlocks nothing except
    // /auth/select-role.
    body.token = signToken(user, null, roles);
    body.roles = await describeRoles(roles);
  } else {
    body.role = roles[0];
    body.token = signToken(user, roles[0], roles);
  }

  res.json(body);
}

// Also used to switch roles later — no password needed while the token is valid.
async function onSelectRole(req, res) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ message: "Your session has expired. Please login again." });
  }

  const role = String(req.body.role || "");
  const { User } = cds.entities("itsm.master");
  const user = await SELECT.one.from(User).where({ userId: token.sub });

  if (!user || !user.isActive) {
    return res.status(403).json({ message: INACTIVE_MESSAGE });
  }

  // Checked against the database, not against what the frontend sent.
  const roles = await rolesOf(user);
  if (!roles.includes(role)) {
    return res.status(403).json({ message: "You are not authorized for this role." });
  }

  res.json({
    token: signToken(user, role, roles),
    role,
    user: { id: user.userId, name: user.name, email: user.email }
  });
}

async function onForgotPassword(req, res) {
  const email = String(req.body.email || "").trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ message: "Please enter a valid email address." });
  }

  const { User } = cds.entities("itsm.master");
  const user = await SELECT.one.from(User).where({ email });

  if (user && user.isActive) {
    await sendPasswordSetupEmail(user, true);
  }

  res.json({ message: FORGOT_MESSAGE });
}

async function onResetPassword(req, res) {
  const { token, password, confirmPassword } = req.body;

  if (String(password || "").length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters." });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ message: "Passwords do not match." });
  }

  const { User, PasswordResetToken } = cds.entities("itsm.master");
  const row = await SELECT.one.from(PasswordResetToken).where({ tokenHash: hashResetToken(token) });

  if (!row || row.usedAt || new Date(row.expiresAt) < new Date()) {
    return res.status(400).json({ message: RESET_EXPIRED_MESSAGE });
  }

  const user = await SELECT.one.from(User).where({ userId: row.userId });
  if (!user) {
    return res.status(400).json({ message: RESET_EXPIRED_MESSAGE });
  }

  await UPDATE(User).set({ passwordHash: await hashPassword(password) }).where({ userId: row.userId });
  await UPDATE(PasswordResetToken).set({ usedAt: new Date().toISOString() }).where({ ID: row.ID });

  res.json({ message: "Password reset successfully." });
}

// ==================== AUTHENTICATION MIDDLEWARE ====================

// CAP custom auth. Anything without a valid token stays anonymous, so
// @requires:'authenticated-user' rejects it with 401 — same as the
// mocked/xsuaa kinds used to.
// <img src> can't send an Authorization header, so logos (not sensitive) are exempt.
const PUBLIC_GET_PATTERNS = [/\/logoContent(\?|$)/];

function jwtAuth(req, res, next) {
  const token = readToken(req);

  if (token && token.role) {
    req.user = new cds.User({ id: token.sub, roles: [CDS_ROLE_BY_CODE[token.role]].filter(Boolean) });
    req.user.email = token.email;
    req.user.roleCode = token.role;
    req.user.roleCodes = token.roles || [];
  } else if (req.method === "GET" && PUBLIC_GET_PATTERNS.some(rx => rx.test(req.path))) {
    req.user = new cds.User({ id: "public-asset-reader", roles: [] });
  } else {
    req.user = cds.User.anonymous;
  }

  next();
}

// ==================== ROUTES ====================

// Any throw in a handler would otherwise leak a stack trace to the browser.
function guard(handler) {
  return function (req, res) {
    Promise.resolve(handler(req, res)).catch(function (error) {
      console.error("Auth request failed:", error);
      res.status(500).json({ message: "Something went wrong. Please try again." });
    });
  };
}

// These four endpoints are the only ones reachable without a token — the
// OData service is @requires:'authenticated-user' end to end, so login and
// password reset can't be CAP actions.
function mountAuthRoutes(app) {
  const router = express.Router();
  router.use(express.json());
  router.post("/login", guard(onLogin));
  router.post("/select-role", guard(onSelectRole));
  router.post("/forgot-password", guard(onForgotPassword));
  router.post("/reset-password", guard(onResetPassword));
  app.use("/auth", router);
}

// ==================== EXPORTS ====================

// CAP loads this module expecting the middleware itself, so the two helpers
// other files need ride along as properties.
module.exports = jwtAuth;
module.exports.mountAuthRoutes = mountAuthRoutes;
module.exports.sendPasswordSetupEmail = sendPasswordSetupEmail;
