const cds = require("@sap/cds");
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const { buildConfirmationEmailTemplate, buildServiceGroupEmailTemplate, buildAssignmentEmailTemplate, buildEmail } = require("./email-templates");
const { transporter, sendEmailSafe } = require("./ticket-helpers");
const { themeForTicket } = require("./email-theme");
const { Ticket, IncidentForm, TicketLog, Attachment } = cds.entities("itsm.transaction");
const { TicketCounter, User, UserRole, Organization } = cds.entities("itsm.master");
// The active auth provider (srv/auth.js selector). local-auth.js exports only
// sendPasswordSetupEmail; cognito-auth.js also exports createUser/setUserRoles/
// setUserActive. Every Cognito-side call below is guarded on those being
// present, so this whole block is a no-op in local mode.
const auth = require("./auth");
const { sendPasswordSetupEmail } = auth;

// Files ride along with the notification so a recipient can open them from
// the mail itself — the content endpoint is behind authentication, so a plain
// link in an email would only ever return 401.
const MAX_MAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) { chunks.push(chunk); }
    return Buffer.concat(chunks);
}

async function mailAttachments(tx, ticketID) {
    const rows = await tx.run(SELECT.from(Attachment).where({ ticketID }));
    const files = [];
    let total = 0;

    for (const row of rows) {
        if (!row.content) { continue; }
        try {
            const buf = Buffer.isBuffer(row.content) ? row.content : await streamToBuffer(row.content);
            // An oversized mail bounces outright, which is worse than a
            // missing file the recipient can still fetch from the app.
            if (total + buf.length > MAX_MAIL_ATTACHMENT_BYTES) {
                console.warn(`[mail] ${row.fileName} not attached — size cap reached`);
                continue;
            }
            total += buf.length;
            files.push({ filename: row.fileName, content: buf, contentType: row.mediaType });
        } catch (e) {
            console.error(`[mail] could not read ${row.fileName}: ${e.message}`);
        }
    }
    return files;
}

const reminderCooldown = {
    CRITICAL: 2,
    HIGH: 4,
    MEDIUM: 8,
    LOW: 24
};

 
// Prefix used in the ticket number, e.g. "INC-00001".
const PREFIX_BY_TYPE = {
  INCIDENT: "INC",
  SERVICE_REQUEST: "SRV",
  CHANGE: "CHG",
  PROBLEM: "PRB"
};
 
module.exports = cds.service.impl(function () {
  "use strict";

  this.on("currentUser", onCurrentUser);
  this.on("ticketAction", onticketAction);
  this.on("sendPasswordSetup", onSendPasswordSetup);
  this.on("reminderStatus", onReminderStatus);
  this.on("sendReminder", onSendReminder);
  this.on("runDailyPendingActionEmails", onRunDailyPendingActionEmails);
  this.before("CREATE", "Tickets", onBeforeCreateTicket);
  this.before("UPDATE", "Tickets", onBeforeUpdateTicket);
  this.before("READ", "Tickets", onBeforeReadTickets);
  this.before("UPDATE", "Organizations", onBeforeUpdateOrganization);
  this.before("CREATE", "Users", onBeforeCreateUser);
  this.after("CREATE", "Users", onAfterCreateUser);
  this.before("UPDATE", "Users", onBeforeUpdateUser);
  this.after("CREATE", "UserRoles", onUserRoleCreated);
  this.before("DELETE", "UserRoles", onBeforeDeleteUserRole);
  this.after("DELETE", "UserRoles", onUserRoleDeleted);
  this.after("READ", "Tickets", onAfterReadTickets);
});


 
async function onticketAction(req) {
 
    const { ticketID, action } = req.data;

    const tx = cds.tx(req);

    if (!ticketID) {
        return req.error(400, "Ticket ID is required");
    }
 
    if (!action) {
        return req.error(400, "Action is required");
    }

    // Each action belongs to exactly one persona — a Consultant can't
    // SUBMIT, a Service Group can't RESOLVE, etc.
    const ROLE_BY_ACTION = {
        SUBMIT: "EndUser",
        ASSIGN: "ServiceGroup",
        RESOLVED: "Consultant",
        CLOSED: "EndUser"
    };
    const requiredRole = ROLE_BY_ACTION[action];
    if (requiredRole && !req.user.is(requiredRole)) {
        return req.error(403, `Only ${requiredRole} can perform action '${action}'`);
    }

    try {
 
        // =====================================================
        // GET TICKET
        // =====================================================
 
        const ticket = await tx.run(
            SELECT.one.from(Ticket).where({
                ticketID: ticketID
            })
        );
 
        if (!ticket) {
            return req.error(404, `Ticket ${ticketID} not found`);
        }
 
 
        // =====================================================
        // SUBMIT
        // =====================================================
 
        if (action === "SUBMIT") {
 
            const now = new Date();
 
            // Original user who created/submitted the ticket
            const userId = req.user?.id;
 
            const currentUser = userId
                ? await tx.run(
                    SELECT.one.from(User).where({
                        userId: userId
                    })
                )
                : null;
 
            const originalUserName =
                currentUser?.name ||
                ticket.createdByName ||
                "Unknown User";
 
            const originalUserEmail =
                currentUser?.email ||
                null;
 
 
            // -------------------------------------------------
            // Update Ticket
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(Ticket)
                    .set({
                        status: "NEW",
                        subStatus: "PENDING",
                        pendingWith: "Service Group",
                        pendingWithName: "Service Group"
                    })
                    .where({
                        ticketID: ticketID
                    })
            );
 
 
            // -------------------------------------------------
            // Create workflow logs
            // -------------------------------------------------
 
            await tx.run(
                INSERT.into(TicketLog).entries([
 
                    // 1. Initiator
                    {
                        ticketID: ticketID,
                        SrNo: 1,
                        stage: "Initiator",
                        status: "Completed",
                        userName: originalUserName,
                        userEmail: originalUserEmail,
                        role: "Agent",
                        receivedDt: ticket.createdAt || now,
                        completionDt: now,
                        remarks: "Ticket initiated and submitted."
                    },
 
                    // 2. Service Group
                    {
                        ticketID: ticketID,
                        SrNo: 2,
                        stage: "Service Group",
                        status: "Pending",
                        userName: null,
                        userEmail: null,
                        role: "ServiceGroup",
                        receivedDt: now,
                        completionDt: null,
                        remarks: "Ticket is pending with Service Group."
                    },
 
                    // 3. Consultant
                    {
                        ticketID: ticketID,
                        SrNo: 3,
                        stage: "Consultant",
                        status: "Not Started Yet",
                        userName: null,
                        userEmail: null,
                        role: "Consultant",
                        receivedDt: null,
                        completionDt: null,
                        remarks: "Ticket is waiting for Consultant assignment."
                    },
 
                    // 4. Resolved
                    // IMPORTANT:
                    // Store original requester details here itself.
                    {
                        ticketID: ticketID,
                        SrNo: 4,
                        stage: "Resolved",
                        status: "Not Started Yet",
                        userName: originalUserName,
                        userEmail: originalUserEmail,
                        role: "Agent",
                        receivedDt: null,
                        completionDt: null,
                        remarks: "Resolution stage has not started yet."
                    }
 
                ])
            );
 
 
            // -------------------------------------------------
            // Send mail to Service Group + confirmation to submitter
            // -------------------------------------------------

            // Re-fetch so the email reflects the just-updated status/subStatus
            const updatedTicket = await tx.run(
                SELECT.one.from(Ticket).where({ ticketID })
            );

            const serviceGroupUsers = await serviceGroupRecipientsForTicket(updatedTicket);

            // Branding follows the requester org, so every mail about this
            // ticket looks the same whoever it is addressed to.
            const theme = await themeForTicket(updatedTicket, tx);
            const attachments = await tx.run(
                SELECT.from(Attachment).columns("fileName", "mediaType", "fileSize").where({ ticketID })
            );
            const mailFiles = await mailAttachments(tx, ticketID);

            if (serviceGroupUsers.length) {
                await sendEmailSafe(transporter, {
                    from: process.env.MAIL_FROM,
                    to: serviceGroupUsers.map(u => u.email),
                    subject: `New Ticket Submitted — ${updatedTicket.ticketNumber}`,
                    html: buildServiceGroupEmailTemplate(updatedTicket, theme, attachments),
                    attachments: mailFiles
                });
            } else {
                console.warn("No active Service Group user found to notify");
            }

            if (originalUserEmail) {
                await sendEmailSafe(transporter, {
                    from: process.env.MAIL_FROM,
                    to: originalUserEmail,
                    subject: `Your ticket ${updatedTicket.ticketNumber} has been submitted`,
                    html: buildConfirmationEmailTemplate(updatedTicket, theme, attachments),
                    attachments: mailFiles
                });
            } else {
                console.warn("Submitter email not found, confirmation mail skipped");
            }

            return `Ticket ${ticketID} submitted successfully`;
        }
 
 
        // =====================================================
        // ASSIGN
        // =====================================================
 
        if (action === "ASSIGN") {
 
            /*
             * consultantId is NOT coming from req.data.
             *
             * The selected Consultant is expected to already
             * be stored in Ticket.messageProcessor.
             */
 
            const consultantId = ticket.messageProcessor;
 
            if (!consultantId) {
                return req.error(
                    400,
                    "No Consultant selected for this ticket."
                );
            }
 
 
            // -------------------------------------------------
            // Get selected Consultant
            // -------------------------------------------------
 
            const consultant = await tx.run(
                SELECT.one.from(User).where({
                    userId: consultantId
                })
            );
 
            if (!consultant) {
                return req.error(
                    404,
                    `Consultant ${consultantId} not found`
                );
            }
 
            const now = new Date();
 
 
            // -------------------------------------------------
            // Get current Service Group user
            // -------------------------------------------------
 
            const serviceGroupUserId = req.user?.id;
 
            const serviceGroupUser = serviceGroupUserId
                ? await tx.run(
                    SELECT.one.from(User).where({
                        userId: serviceGroupUserId
                    })
                )
                : null;
 
 
            // -------------------------------------------------
            // Service Group log → Completed
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(TicketLog)
                    .set({
                        status: "Completed",
                        completionDt: now,
                        userName: serviceGroupUser?.name,
                        userEmail: serviceGroupUser?.email,
                        role: "ServiceGroup",
                        remarks: `Ticket assigned to Consultant ${consultant.name}.`
                    })
                    .where({
                        ticketID: ticketID,
                        stage: "Service Group"
                    })
            );
 
 
            // -------------------------------------------------
            // Consultant log → Pending
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(TicketLog)
                    .set({
                        status: "Pending",
                        receivedDt: now,
                        userName: consultant.name,
                        userEmail: consultant.email,
                        role: "Consultant",
                        remarks: "Ticket assigned to Consultant."
                    })
                    .where({
                        ticketID: ticketID,
                        stage: "Consultant"
                    })
            );
 
 
            // -------------------------------------------------
            // Update Ticket
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(Ticket)
                    .set({
                        messageProcessor: consultant.userId,
                        pendingWith: "Consultant",
                        pendingWithName: consultant.name,
                        status: "ASSIGNED",
                        subStatus: "IN_PROGRESS",
                        assignedAt: now
                    })
                    .where({
                        ticketID: ticketID
                    })
            );
 
 
            // -------------------------------------------------
            // Send mail to Consultant
            // -------------------------------------------------

            const updatedTicket = await tx.run(
                SELECT.one.from(Ticket).where({ ticketID })
            );

            const theme = await themeForTicket(updatedTicket, tx);
            const attachments = await tx.run(
                SELECT.from(Attachment).columns("fileName", "mediaType", "fileSize").where({ ticketID })
            );
            const mailFiles = await mailAttachments(tx, ticketID);

            if (consultant.email) {
                await sendEmailSafe(transporter, {
                    from: process.env.MAIL_FROM,
                    to: consultant.email,
                    subject: `Ticket Assigned — ${updatedTicket.ticketNumber}`,
                    html: buildAssignmentEmailTemplate(updatedTicket, consultant.name, theme, attachments),
                    attachments: mailFiles
                });
            } else {
                console.warn("Consultant email not found, assignment mail skipped");
            }

            return `Ticket ${ticketID} assigned to ${consultant.name}`;
        }
 
 
        // =====================================================
        // RESOLVED
        // =====================================================
 
        if (action === "RESOLVED") {
 
            if (ticket.status !== "ASSIGNED") {
                return req.error(
                    400,
                    `Ticket cannot be resolved from status ${ticket.status}`
                );
            }
 
            const now = new Date();
 
 
            // -------------------------------------------------
            // Get original requester
            // -------------------------------------------------
 
            const originalUser = ticket.reportedBy
                ? await tx.run(
                    SELECT.one.from(User).where({
                        userId: ticket.reportedBy
                    })
                )
                : null;
 
 
            // -------------------------------------------------
            // Get Consultant
            // -------------------------------------------------
 
            const consultant = ticket.messageProcessor
                ? await tx.run(
                    SELECT.one.from(User).where({
                        userId: ticket.messageProcessor
                    })
                )
                : null;
 
 
            // -------------------------------------------------
            // Consultant log → Completed
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(TicketLog)
                    .set({
                        status: "Completed",
                        completionDt: now,
                        userName: consultant?.name,
                        userEmail: consultant?.email,
                        role: "Consultant",
                        remarks: "Consultant resolved the ticket."
                    })
                    .where({
                        ticketID: ticketID,
                        stage: "Consultant"
                    })
            );
 
 
            // -------------------------------------------------
            // Resolved log → Pending
            //
            // IMPORTANT:
            // Original requester details were already stored
            // during SUBMIT.
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(TicketLog)
                    .set({
                        status: "Pending",
                        receivedDt: now,
                        role: "Agent",
                        remarks: "Ticket resolved and waiting for requester confirmation."
                    })
                    .where({
                        ticketID: ticketID,
                        stage: "Resolved"
                    })
            );
 
 
            // -------------------------------------------------
            // Update Ticket
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(Ticket)
                    .set({
                        status: "RESOLVED",
                        subStatus: "PENDING",
                        pendingWith: "Agent",
                        pendingWithName:
                            originalUser?.name ||
                            ticket.createdByName,
                        completedAt: now
                    })
                    .where({
                        ticketID: ticketID
                    })
            );
 
 
            // -------------------------------------------------
            // TODO: Send mail to original requester
            // -------------------------------------------------
 
            // await sendMailToRequester({
            //     requester: originalUser,
            //     ticket
            // });
 
 
            return `Ticket ${ticketID} resolved successfully`;
        }
 
 
        // =====================================================
        // CLOSED
        // =====================================================
 
        if (action === "CLOSED") {
 
            if (ticket.status !== "RESOLVED") {
                return req.error(
                    400,
                    `Ticket cannot be closed from status ${ticket.status}`
                );
            }
 
            const now = new Date();
 
 
            // -------------------------------------------------
            // Close all workflow logs
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(TicketLog)
                    .set({
                        status: "Closed",
                        completionDt: now
                    })
                    .where({
                        ticketID: ticketID
                    })
            );
 
 
            // -------------------------------------------------
            // Close Ticket
            // -------------------------------------------------
 
            await tx.run(
                UPDATE(Ticket)
                    .set({
                        status: "CLOSED",
                        subStatus: "COMPLETED",
                        pendingWith: null,
                        pendingWithName: null
                    })
                    .where({
                        ticketID: ticketID
                    })
            );
 
 
            // -------------------------------------------------
            // TODO: Send final mail
            // -------------------------------------------------
 
            // await sendClosureMail(ticket);
 
 
            return `Ticket ${ticketID} closed successfully`;
        }
        // INVALID ACTION
        return req.error(
            400,
            `Unsupported action: ${action}`
        );
    } catch (error) {
 
        console.error(
            `Error performing ${action} on ticket ${ticketID}:`,
            error
        );
 
        return req.error(
            500,
            `Failed to perform ${action}: ${error.message}`
        );
    }
}
async function onCurrentUser(req) {
  var sPersona = "END_USER";
  if (req.user.is("Admin")) { sPersona = "ADMIN"; }
  else if (req.user.is("Consultant")) { sPersona = "CONSULTANT"; }
  else if (req.user.is("ServiceGroup")) { sPersona = "SERVICE_GROUP"; }

  const oUser = await SELECT.one.from(User).where({ userId: req.user.id });

  return {
    persona: sPersona,
    userName: req.user.id,
    name: oUser?.name || req.user.id,
    email: oUser?.email || req.user.email,
    // Straight off the verified token — the header's role menu offers
    // exactly these, and /auth/select-role re-checks against the DB anyway.
    roles: req.user.roleCodes || [],
    theme: await resolveUserTheme(req.user.id)
  };
}

// Login matches on email, so it has to be stored one consistent way.
function onBeforeCreateUser(req) {
  if (req.data.email) { req.data.email = req.data.email.trim().toLowerCase(); }
  if (!req.data.userId) { req.data.userId = req.data.email; }
}

// A new user has no password. Give them their primary role, then either create
// the Cognito identity (Cognito mails the invite) or, in local mode, mail our
// own setup link. The admin never sees or sets the password.
async function onAfterCreateUser(oUser, req) {
  if (!oUser.userId) { return; }

  if (oUser.role) {
    const existing = await SELECT.one.from(UserRole).where({ userId: oUser.userId, role: oUser.role });
    if (!existing) {
      await INSERT.into(UserRole).entries({ userId: oUser.userId, role: oUser.role });
    }
  }

  if (!oUser.email) { return; }

  // Cognito mode: the identity must exist in Cognito too, and the invite mail
  // Cognito sends replaces our own. If Cognito refuses, the ITSM row would be
  // an account nobody can log in to, so it is rolled back.
  if (auth.createUser) {
    try {
      const sub = await auth.createUser(oUser, oUser.role ? [oUser.role] : []);
      await UPDATE(User).set({ cognitoUserId: sub }).where({ userId: oUser.userId });
    } catch (error) {
      await DELETE.from(User).where({ userId: oUser.userId });
      await DELETE.from(UserRole).where({ userId: oUser.userId });
      return req.error(400, `Could not create the user in Cognito: ${error.name || "unknown error"}`);
    }
    return;
  }

  await sendPasswordSetupEmail(oUser, false);
}

// Cognito mode only (guarded): keep the Cognito account in step when an admin
// deactivates or reactivates a user. Role changes go through the UserRoles
// handlers below, not here.
async function onBeforeUpdateUser(req) {
  if (!auth.setUserActive || req.data.isActive === undefined) { return; }

  const [key] = req.params;
  const current = await SELECT.one.from(User).where(key);
  if (!current || !current.cognitoUserId || req.data.isActive === current.isActive) { return; }

  try {
    await auth.setUserActive(current, req.data.isActive);
  } catch (error) {
    return req.error(400, `Could not update the user in Cognito: ${error.name || "unknown error"}`);
  }
}

// The Admin panel edits a user's roles as UserRoles rows via generic CRUD, not
// through User.role — so this is the only place multi-role changes reach
// Cognito. After any add/remove we push the user's full current role set;
// setUserRoles reconciles the Cognito groups from there. Cognito mode only.
async function syncCognitoGroups(userId, req) {
  if (!auth.setUserRoles || !userId) { return; }

  const user = await SELECT.one.from(User).where({ userId });
  if (!user || !user.cognitoUserId) { return; }

  const rows = await SELECT.from(UserRole).where({ userId });
  const codes = [...new Set(rows.map(row => row.role).filter(Boolean))];

  try {
    await auth.setUserRoles(user, codes);
  } catch (error) {
    return req.error(400, `Could not sync roles to Cognito: ${error.name || "unknown error"}`);
  }
}

function onUserRoleCreated(row, req) {
  return syncCognitoGroups(row && row.userId, req);
}

// after DELETE can't see the removed row, so capture its owner first.
async function onBeforeDeleteUserRole(req) {
  if (!auth.setUserRoles) { return; }
  const [key] = req.params;
  const row = await SELECT.one.from(UserRole).where(key);
  req.__cognitoSyncUserId = row && row.userId;
}

function onUserRoleDeleted(_data, req) {
  return syncCognitoGroups(req.__cognitoSyncUserId, req);
}

async function onSendPasswordSetup(req) {
  if (!req.user.is("Admin")) {
    return req.error(403, "Admin role required");
  }

  const oUser = await SELECT.one.from(User).where({ userId: req.data.userId });
  if (!oUser || !oUser.email) {
    return req.error(404, "User not found");
  }

  await sendPasswordSetupEmail(oUser, false);
  return `Password setup link sent to ${oUser.email}.`;
}
async function resolveUserTheme(sUserId) {
  const oUser = await SELECT.one.from(User).where({ userId: sUserId });
  if (!oUser || !oUser.client) { return null; }
 
  const oOrg = await SELECT.one.from(Organization).where({ code: oUser.client, isActive: true });
  if (!oOrg) { return null; }
 
  return {
    themeType: oOrg.themeType,
    themeScope: oOrg.themeScope,
    primaryColor: oOrg.primaryColor,
    secondaryColor: oOrg.secondaryColor,
    logo: oOrg.logo,
    newTicketBtnColor: oOrg.newTicketBtnColor,
    newTicketBtnTextColor: oOrg.newTicketBtnTextColor,
    formBtnColor: oOrg.formBtnColor,
    formBtnTextColor: oOrg.formBtnTextColor
  };
}
// Org-scopes Service Group/Consultant: they only see tickets whose reporter
// is from their own org (User.client). Blank client = ccentrik-wide staff,
// unrestricted, same as today.
async function onBeforeReadTickets(req) {
  if (!req.user.is("ServiceGroup") && !req.user.is("Consultant")) { return; }

  const me = await SELECT.one.from(User).where({ userId: req.user.id });
  if (!me || !me.client) { return; }

  req.query.where({ "reportedByUser.client": me.client });
}

async function onBeforeCreateTicket(req) {
  const ticket = req.data;
  const identifiers = await generateTicketIdentifiers(ticket.ticketType);
 
  ticket.ticketID = identifiers.ticketID;
  ticket.ticketNumber = identifiers.ticketNumber;
  ticket.status = ticket.status || "DRAFT";
  ticket.priority = ticket.priority || "MEDIUM";
  ticket.reportedBy = req.user.id;
  ticket.createdByName = req.user.id;
}
async function onBeforeUpdateTicket(req) {
  if (req.data.messageProcessor) {
    req.data.assignedAt = new Date().toISOString();
  }
  if (req.data.status === "CLOSED") {
    req.data.completedAt = new Date().toISOString();
  }
  if (req.data.incidentForm) {
    const oFormData = req.data.incidentForm;
    delete oFormData.ID;
    delete oFormData.ticketID;
    delete req.data.incidentForm;
 
    if (Object.keys(oFormData).length) {
      const [oKey] = req.params;
      const ticketID = oKey.ticketID;
 
      const existingForm = await SELECT.one.from(IncidentForm).where({ ticketID });
 
      if (existingForm) {
        await UPDATE(IncidentForm).set(oFormData).where({ ticketID });
      } else {
        await INSERT.into(IncidentForm).entries({ ticketID, ...oFormData });
      }
    }
  }
}
async function onBeforeUpdateOrganization(req) {
  if (!req.data.code) { return; }
 
  const [oKey] = req.params;
  const oOrg = await SELECT.one.from(Organization).where({ ID: oKey.ID });
  if (oOrg && oOrg.code && oOrg.code !== req.data.code) {
    await UPDATE(User).set({ client: req.data.code }).where({ client: oOrg.code });
  }
}
async function generateTicketIdentifiers(sTicketType) {
  const sType = (sTicketType || "GENERAL").trim().toUpperCase();

  let nUpdated = await UPDATE(TicketCounter).set("lastNumber = lastNumber + 1").where({ type: sType });
  if (!nUpdated) {
    // First ticket ever of this type — no row to increment yet. Two
    // requests can both land here at once, so if the insert loses that
    // race (row already exists by the time it runs), fall back to the
    // same atomic increment rather than erroring out.
    try {
      await INSERT.into(TicketCounter).entries({ type: sType, lastNumber: 1 });
    } catch (e) {
      nUpdated = await UPDATE(TicketCounter).set("lastNumber = lastNumber + 1").where({ type: sType });
      if (!nUpdated) { throw e; }
    }
  }

  const oCounter = await SELECT.one.from(TicketCounter).where({ type: sType });
  const sPrefix = PREFIX_BY_TYPE[sType] || sType.slice(0, 3);
  const sNumber = sPrefix + "-" + String(oCounter.lastNumber).padStart(5, "0");

  return { ticketID: sNumber, ticketNumber: sNumber };
}


 

// Stamps each returned Ticket with reminderReady (a virtual field, see
// schema.cds) so the frontend's reminder bell has a plain scalar boolean
// to bind — a to-many composition like ticketLogs can't be used as a
// scalar "part" in a UI5 property binding, OData v4's model refuses it.
async function onAfterReadTickets(data) {
    const aTickets = Array.isArray(data) ? data : (data ? [data] : []);
    for (const ticket of aTickets) {
        const status = await getReminderStatus(ticket.ticketID);
        ticket.reminderReady = !!status.enabled;
    }
}

// Decides whether the reminder bell is clickable for a ticket — rate
// limited per priority (reminderCooldown) since the last time a reminder
// was actually sent (found via TicketLog's own REMINDER-stage rows).
async function getReminderStatus(ticketID) {
    const ticket = await SELECT.one.from(Ticket).where({ ticketID });
    if (!ticket) {
        return { enabled: false };
    }

    const cooldownHours = reminderCooldown[ticket.priority] || 8;

    const lastReminder = await SELECT.one.from(TicketLog)
        .where({ ticketID, stage: "REMINDER" })
        .orderBy({ receivedDt: "desc" });

    if (!lastReminder) {
        return { enabled: true };
    }

    const nextAllowedAt = new Date(lastReminder.receivedDt).getTime() + cooldownHours * 60 * 60 * 1000;

    if (Date.now() < nextAllowedAt) {
        return { enabled: false, nextAllowedAt: new Date(nextAllowedAt).toISOString() };
    }

    return { enabled: true };
}

async function onReminderStatus(req) {
    return getReminderStatus(req.data.ticketID);
}

// Maps Ticket.pendingWith (a role label — "Service Group"/"Consultant"/
// "Agent", set by onticketAction, never an email) to who should actually
// receive an email right now. Shared by sendTicketReminder (the bell) and
// runDailyPendingActionEmails (the daily digest) so both agree on who's
// "pending" for a given ticket.
// A user can hold several roles (master.UserRole). User.role is only the
// primary one, so filtering on it alone silently skips multi-role users.
// Queried fresh on every call so users created after startup are included.
async function usersWithRole(role) {
    const users = await SELECT.from(User).where({ isActive: true });
    const roleRows = await SELECT.from(UserRole).where({ role });
    const ids = roleRows.map(row => row.userId);
    return users.filter(user => ids.includes(user.userId) || user.role === role);
}

// Same org-scoping as onBeforeReadTickets: a Service Group member with an
// org (client) set only hears about that org's tickets; blank client
// (ccentrik-wide staff) hears about every org, same as they see every org.
async function serviceGroupRecipientsForTicket(ticket) {
    const users = await usersWithRole("SERVICE_GROUP");
    const reporter = ticket.reportedBy
        ? await SELECT.one.from(User).where({ userId: ticket.reportedBy })
        : null;
    if (!reporter || !reporter.client) { return users; }
    return users.filter(u => !u.client || u.client === reporter.client);
}

async function getPendingRecipient(ticket) {
    if (!ticket.pendingWith) {
        return null;
    }

    if (ticket.pendingWith === "Service Group") {
        const users = await serviceGroupRecipientsForTicket(ticket);
        return { type: "ServiceGroup", emails: users.map(u => u.email).filter(Boolean) };
    }

    if (ticket.pendingWith === "Consultant") {
        const consultant = ticket.messageProcessor
            ? await SELECT.one.from(User).where({ userId: ticket.messageProcessor, isActive: true })
            : null;
        return { type: "Consultant", emails: consultant?.email ? [consultant.email] : [] };
    }

    // "Agent" — set after RESOLVED, waiting on the original requester.
    if (ticket.pendingWith === "Agent") {
        const requester = ticket.reportedBy
            ? await SELECT.one.from(User).where({ userId: ticket.reportedBy, isActive: true })
            : null;
        return { type: "EndUser", emails: requester?.email ? [requester.email] : [] };
    }

    return null;
}

// Sent when someone clicks the bell — nudges whoever the ticket is
// currently pending with, subject to the cooldown above.
async function sendTicketReminder(ticketID, req) {
    const ticket = await SELECT.one.from(Ticket).where({ ticketID });
    if (!ticket) {
        return req.error(404, "Ticket not found");
    }

    const recipient = await getPendingRecipient(ticket);
    if (!recipient) {
        return req.error(400, "No pending action for this ticket.");
    }
    if (!recipient.emails.length) {
        return req.error(400, `No email address found for ${recipient.type}.`);
    }

    const reminderStatus = await getReminderStatus(ticketID);
    if (!reminderStatus.enabled) {
        return req.error(429, "Reminder cooldown is still active.");
    }

    const now = new Date();
    const message = recipient.type === "ServiceGroup"
        ? "This ticket is waiting for consultant assignment."
        : "This ticket is waiting for your action.";

    await sendEmailSafe(transporter, {
        from: process.env.MAIL_FROM,
        to: recipient.emails,
        subject: `Reminder: Ticket ${ticket.ticketNumber || ticket.ticketID} is waiting for action`,
        html: buildEmail("Reminder: Action Required", message, [ticket], await themeForTicket(ticket))
    });

    await INSERT.into(TicketLog).entries({
        ticketID,
        stage: "REMINDER",
        status: "Sent",
        userName: req.user?.id || null,
        userEmail: recipient.emails.join(", "),
        role: recipient.type,
        receivedDt: now,
        completionDt: now,
        remarks: `Reminder sent to ${recipient.type}.`
    });

    return {
        sent: true,
        ticketID,
        recipientType: recipient.type
    };
}

async function onSendReminder(req) {
    return sendTicketReminder(req.data.ticketID, req);
}

// Daily digest — meant to be called by an SAP BTP Job Scheduler binding.
// No scheduling/time logic in here, just "send today's pending list".
async function runDailyPendingActionEmails() {
    const tickets = await SELECT.from(Ticket);
    const pending = {};

    for (const ticket of tickets) {

        // A Draft never got pendingWith set (that only happens on SUBMIT) —
        // remind the End User who created it to actually submit it.
        if (ticket.status === "DRAFT") {
            const user = await SELECT.one.from(User).where({ userId: ticket.reportedBy, isActive: true });
            if (!user?.email) {
                continue;
            }

            const key = `EndUser_${user.userId}`;
            if (!pending[key]) {
                pending[key] = { emails: [user.email], type: "EndUser", tickets: [] };
            }
            pending[key].tickets.push(ticket);
            continue;
        }

        const recipient = await getPendingRecipient(ticket);
        if (!recipient || !recipient.emails.length) {
            continue;
        }

        // Service Group gets one shared email per distinct recipient set, not
        // one per ticket — but that recipient set is now org-scoped (see
        // serviceGroupRecipientsForTicket), so two tickets from different
        // orgs can land with two different Service Group audiences and must
        // not be merged into the same bucket/key.
        if (recipient.type === "ServiceGroup") {
            const key = "ServiceGroup_" + recipient.emails.slice().sort().join(",");
            if (!pending[key]) {
                pending[key] = { emails: recipient.emails, type: "ServiceGroup", tickets: [] };
            }
            pending[key].tickets.push(ticket);
            continue;
        }

        const key = `${recipient.type}_${recipient.emails[0]}`;
        if (!pending[key]) {
            pending[key] = { emails: recipient.emails, type: recipient.type, tickets: [] };
        }
        pending[key].tickets.push(ticket);
    }

    for (const item of Object.values(pending)) {
        if (!item.tickets.length) {
            continue;
        }

        // A batch can span organisations, so brand it only when it does not.
        const requesters = [...new Set(item.tickets.map(x => x.reportedBy))];
        const theme = requesters.length === 1 ? await themeForTicket(item.tickets[0]) : undefined;

        await sendEmailSafe(transporter, {
            from: process.env.MAIL_FROM,
            to: item.emails,
            subject: `You have ${item.tickets.length} ticket(s) requiring action`,
            html: buildEmail(
                "Pending Tickets",
                `You have ${item.tickets.length} ticket(s) requiring your action.`,
                item.tickets,
                theme
            )
        });
    }

    return { completed: true };
}

async function onRunDailyPendingActionEmails() {
    return runDailyPendingActionEmails();
}
