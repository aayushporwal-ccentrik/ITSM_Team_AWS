"use strict";

// DB role codes (LookupValue lookupType='ROLE', User.role, UserRole.role, and
// the Cognito group names) mapped to the role names the service already checks
// with req.user.is(...). Both auth providers read this — keep it the only place
// the two spellings meet.
const CDS_ROLE_BY_CODE = {
  END_USER: "EndUser",
  SERVICE_GROUP: "ServiceGroup",
  CONSULTANT: "Consultant",
  ADMIN: "Admin"
};

module.exports = { CDS_ROLE_BY_CODE };
