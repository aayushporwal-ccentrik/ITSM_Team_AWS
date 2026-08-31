namespace itsm;
 
using { cuid, managed } from '@sap/cds/common';
 
context transaction {
 
    entity Ticket : managed {
 
        key ticketID     : String;
 
        ticketNumber     : String;
        ticketType       : String;
 
        shortDescription : String;
        description      : String;
        status           : String;
        subStatus        : String;
        priority         : String;
 
        reportedBy       : String;
        createdByName     : String;
        createdByLocation : String;
        pendingWith       : String;
        pendingWithName     : String;
        orgName           : String;
        messageProcessor : String;
        supportTeam      : String;
 
        reportedByUser : Association to master.User
            on reportedByUser.userId = reportedBy;
 
        firstResponseAt  : Timestamp;
        dueAt            : Timestamp;
        completedAt      : Timestamp;
        assignedAt       : Timestamp;
 
        incidentForm : Composition of one IncidentForm
            on incidentForm.ticketID = $self.ticketID;
           
        attachments : Composition of many Attachment
            on attachments.ticketID = $self.ticketID;
 
        ticketLogs : Composition of many TicketLog
            on ticketLogs.ticketID = $self.ticketID;

        // Computed at read time (see srv/service.js), not persisted — a
        // to-many composition like ticketLogs can't be used as a scalar
        // "part" in a UI5 property binding (OData v4's model refuses it,
        // "Accessed value is not primitive"), so the reminder bell's
        // enabled/color state needs a real scalar field to bind to.
        virtual reminderReady : Boolean;
    }
 
    entity IncidentForm : cuid {
 
        ticketID : String;
 
        description : LargeString;
 
        category1 : String;
        category2 : String;
        category3 : String;
        category4 : String;
 
        impact : String;
        urgency : String;
        recommendedPriority : String;
        configurationItem : String;
    }
 
    entity Attachment : cuid, managed {
 
        @Core.ContentDisposition.Filename : fileName
        @Core.MediaType : mediaType
        content : LargeBinary;
 
        ticketID : String;
 
        mediaType   : String;
        fileName    : String;
        fileSize    : Integer;
        storagePath : String;
    }
 
    entity TicketLog : cuid, managed {
    SrNo         : Integer;
    ticketID        : String;
    stage           : String;
    status          : String;
    userName        : String;
    userEmail       : String;
    role            : String;
    receivedDt      : DateTime;
    completionDt    : DateTime;
    remarks         : String(4000);
    }
}
 
context master {
 
    entity LookupValue : cuid, managed {
 
        lookupType  : String;
        code        : String;
        name        : String;
        description : String;
        sequence    : Integer;
        isDefault   : Boolean;
        isActive    : Boolean;
    }
 
    entity TicketCounter : managed {
        key type : String;
        lastNumber : Integer;
    }
 
    // Prevents duplicate userId (repeated Admin "Add User" clicks used to allow it).
    @assert.unique.userId: [userId]
    entity User : cuid, managed {
        userId   : String;
        name     : String;
        email    : String;
        isActive : Boolean;
        role     : String;   // primary/default role, kept as-is; UserRole below is what login actually reads
        client   : String;

        // A user can hold several roles; UserRole is the real list and role
        // above is only the primary one.
        userRoles : Association to many UserRole on userRoles.userId = userId;

        // Set only when AUTH_PROVIDER=cognito - the Cognito user's "sub".
        // This is what links that identity to this row. Null in local mode
        // and for any user not yet provisioned in Cognito.
        // Excluded from the Users projection - never leaves the server, and
        // an admin can't set it through generic CRUD.
        cognitoUserId : String(64);

        // Never sent to the frontend - stripped in srv/service.js before READ Users.
        // Used by the local auth provider only; Cognito owns passwords in hybrid.
        passwordHash : String(200);
    }

    // A user can hold more than one role. Matched by plain userId string,
    // same convention as User.client -> Organization.code.
    // Role codes come from LookupValue(lookupType='ROLE').
    entity UserRole : cuid, managed {
        userId : String;
        role   : String;
    }

    // Single-use link for "set your password" and "forgot password".
    // Only the hash of the token is stored, never the token itself.
    entity PasswordResetToken : cuid, managed {
        userId    : String;
        tokenHash : String(64);
        expiresAt : Timestamp;
        usedAt    : Timestamp;
    }
 
    entity Organization : cuid, managed {
        code              : String(20);
        name              : String(100);
        isActive          : Boolean default true;
        themeType         : String(20) default 'SOLID';      // 'SOLID' | 'GRADIENT'
        themeScope        : String(20) default 'HEADER';     // 'HEADER' (header strip + buttons only) | 'BACKGROUND' (whole page canvas, cards/tables stay white)
        primaryColor      : String(20);
        secondaryColor    : String(20);
        gradientDirection : String(20) default 'TOP_BOTTOM'; // fixed by spec, not user-editable
        logo              : String(500);                     // effective logo URL shown to end users — points at logoContent below once uploaded, or an admin-pasted external URL
 
        // Button colors — always solid, never the header/background gradient.
        // Two independent groups: the Dashboard's "New Ticket" button, and the
        // ticket form's Delete/Edit/Save/Assign/Resolve/Close/Submit buttons.
        newTicketBtnColor     : String(20);
        newTicketBtnTextColor : String(20);
        formBtnColor          : String(20);
        formBtnTextColor      : String(20);
 
        @Core.ContentDisposition.Filename : logoFileName
        @Core.MediaType : logoMediaType
        logoContent   : LargeBinary; // set when the admin uploads a file directly, same media-stream mechanism as Attachment.content
        logoFileName  : String;
        logoMediaType : String;
    }
 
    entity OrganizationSLA : cuid, managed {
 
        organizationId   : String;
        organizationName : String;
 
        impact           : String;
        urgency          : String;
        impactedUserFrom : Integer;
        impactedUserTo   : Integer;
        priority         : String;
        firstResponseMinutes : Integer;
        resolutionMinutes    : Integer;
 
        isActive : Boolean;
    }
}
 