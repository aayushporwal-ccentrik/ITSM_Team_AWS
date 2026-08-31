using { itsm.master as master, itsm.transaction as txn } from '../db/schema';
 
@path: 'ITSMService'
@requires: 'authenticated-user'
service ITSMService {
 
    // Master Data
    entity LookupValues       as projection on master.LookupValue;

    // Used by the Message Processor dropdown, the client-filter join, and
    // to resolve a logged-in user's org/theme.
    // passwordHash and cognitoUserId are excluded here, so they can never
    // leave the server — and an admin can never set either through the
    // generic CRUD.
    entity Users              as projection on master.User excluding { passwordHash, cognitoUserId };

    // Which roles a user may log in as. Plain generic CRUD — the Admin
    // panel's role checkboxes just create/delete rows here.
    entity UserRoles          as projection on master.UserRole;

    // Admin panel: organizations list + per-org theme/logo.
    entity Organizations      as projection on master.Organization;

    // Transaction Data
    entity Tickets            as projection on txn.Ticket;
    entity TicketLogs         as projection on txn.TicketLog;

    action ticketAction(ticketID : String, action: String) returns String;

    // Admin panel: send (or re-send) the "set your password" link.
    action sendPasswordSetup(userId : String) returns String;

    // Tells the frontend which persona the logged-in user is and (for an
    // End User whose org has a theme set) what colors/logo to apply.
    // roles = every role this user may switch to, for the header's role menu.
    function currentUser() returns { persona: String; userName: String; name: String; email: String; roles: many String; theme: { themeType: String; themeScope: String; primaryColor: String; secondaryColor: String; logo: String; newTicketBtnColor: String; newTicketBtnTextColor: String; formBtnColor: String; formBtnTextColor: String; }; };

    // Reminder bell: whether it's clickable right now (cooldown check),
    // and the action behind clicking it.
    function reminderStatus(ticketID: String) returns { enabled: Boolean; nextAllowedAt: String; };
    action sendReminder(ticketID: String) returns { sent: Boolean; ticketID: String; recipientType: String; };

    // Daily digest — called by an SAP BTP Job Scheduler binding, not from the UI.
    action runDailyPendingActionEmails() returns { completed: Boolean; };

}
 