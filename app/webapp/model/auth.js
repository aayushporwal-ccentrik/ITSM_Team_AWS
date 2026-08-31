sap.ui.define([], function () {
  "use strict";

  // The one place the JWT lives and the only place /auth/* is called from.
  // sessionStorage, not localStorage — closing the tab logs you out.
  var TOKEN_KEY = "itsm.token";
  var ROLE_KEY = "itsm.role";

  // Where each role lands after login or a role switch — the same strings
  // as the route patterns in manifest.json. This is the only copy of the
  // mapping; Component.js reads it from here.
  var ROLE_ROUTES = {
    ADMIN: "organizations",
    SERVICE_GROUP: "service-group-dashboard",
    CONSULTANT: "assigned",
    END_USER: ""
  };

  // Display name per role code, for the header's role menu.
  var ROLE_LABELS = {
    ADMIN: "Admin",
    SERVICE_GROUP: "Service Group",
    CONSULTANT: "Consultant",
    END_USER: "End User"
  };

  function post(sPath, oBody) {
    var oHeaders = { "Content-Type": "application/json" };
    var sToken = auth.getToken();
    if (sToken) { oHeaders.Authorization = "Bearer " + sToken; }
    // Cognito's token lists the roles a user may use but no active one; the
    // backend re-checks this header against the token on every request. The
    // local provider reads the role from the token and ignores it.
    var sRole = auth.getRole();
    if (sRole) { oHeaders["X-Active-Role"] = sRole; }

    return fetch("/auth/" + sPath, {
      method: "POST",
      headers: oHeaders,
      body: JSON.stringify(oBody)
    }).then(function (oResponse) {
      return oResponse.json().catch(function () { return {}; }).then(function (oData) {
        if (!oResponse.ok) {
          throw new Error(oData.message || "Something went wrong. Please try again.");
        }
        return oData;
      });
    });
  }

  var auth = {

    ROLE_ROUTES: ROLE_ROUTES,
    ROLE_LABELS: ROLE_LABELS,

    getToken: function () {
      return window.sessionStorage.getItem(TOKEN_KEY);
    },

    getRole: function () {
      return window.sessionStorage.getItem(ROLE_KEY);
    },

    // sRole is null while the user still has to pick one — that token is
    // only good for selectRole().
    setSession: function (sToken, sRole) {
      window.sessionStorage.setItem(TOKEN_KEY, sToken);
      if (sRole) {
        window.sessionStorage.setItem(ROLE_KEY, sRole);
      } else {
        window.sessionStorage.removeItem(ROLE_KEY);
      }
    },

    clearSession: function () {
      window.sessionStorage.removeItem(TOKEN_KEY);
      window.sessionStorage.removeItem(ROLE_KEY);
    },

    login: function (sEmail, sPassword) {
      return post("login", { email: sEmail, password: sPassword }).then(function (oData) {
        // A brand-new Cognito user has to replace their one-time password
        // before any token exists — nothing to store yet in that case.
        if (!oData.passwordChangeRequired) {
          auth.setSession(oData.token, oData.role);
        }
        return oData;
      });
    },

    // Same call for the first pick and for switching roles later.
    selectRole: function (sRole) {
      return post("select-role", { role: sRole }).then(function (oData) {
        auth.setSession(oData.token, oData.role);
        return oData;
      });
    },

    forgotPassword: function (sEmail) {
      return post("forgot-password", { email: sEmail });
    },

    // token is either the one from an emailed link (local) or a code the user
    // typed (Cognito); email only matters for the code, which on its own does
    // not say who is resetting. Caller passes whichever it has.
    resetPassword: function (oParams) {
      return post("reset-password", oParams);
    },

    // Finishes the "choose your own password" step a newly created Cognito
    // user lands on at first login. session comes from that login reply, and
    // the response signs them straight in.
    setInitialPassword: function (oParams) {
      return post("set-initial-password", oParams).then(function (oData) {
        auth.setSession(oData.token, oData.role);
        return oData;
      });
    },

    // The OData model has to carry the token on every request. Called on
    // startup and again after every role switch, since the token changes.
    applyToken: function (oModel) {
      var sToken = auth.getToken();
      var sRole = auth.getRole();
      oModel.changeHttpHeaders({
        Authorization: sToken ? "Bearer " + sToken : undefined,
        "X-Active-Role": sRole || undefined
      });
    }
  };

  return auth;
});
