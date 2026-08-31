sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "itsm/ui/model/auth"
], function (Controller, auth) {
  "use strict";

  // One controller for all three auth routes — the view swaps between a
  // sign-in, forgot-password and reset-password block (see Login.view.xml).
  var BLOCKS = ["loginBlock", "forgotBlock", "resetBlock"];

  return Controller.extend("itsm.ui.controller.Login", {

    onTogglePassword: function (oEvent) {
      var oBtn = oEvent.getSource();
      var oInput = this.byId(oBtn.data("target"));
      var bHidden = oInput.getType() === "Password";
      oInput.setType(bHidden ? "Text" : "Password");
      oBtn.setIcon(bHidden ? "sap-icon://hide" : "sap-icon://show");
    },

    onInit: function () {
      var oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("login").attachPatternMatched(this._onShowLogin, this);
      oRouter.getRoute("forgotPassword").attachPatternMatched(this._onShowForgot, this);
      oRouter.getRoute("resetPassword").attachPatternMatched(this._onShowReset, this);
    },

    _showBlock: function (sId) {
      var that = this;
      BLOCKS.forEach(function (sBlock) {
        that.byId(sBlock).setVisible(sBlock === sId);
      });
    },

    // ===== Sign in =====

    // Landing here always means starting over — drop whatever token was
    // left behind, so a half-finished login can't linger.
    _onShowLogin: function () {
      auth.clearSession();
      this._showBlock("loginBlock");
      this.byId("loginError").setVisible(false);
      this.byId("loginPassword").setValue("");
    },

    onLogin: function () {
      var that = this;
      var sEmail = this.byId("loginEmail").getValue().trim();
      var sPassword = this.byId("loginPassword").getValue();

      if (!sEmail || !sPassword) {
        return this._showError("Please enter your email and password.");
      }

      this.byId("loginError").setVisible(false);
      this.byId("loginButton").setBusy(true);

      auth.login(sEmail, sPassword).then(function (oData) {
        that.byId("loginButton").setBusy(false);

        // First login of an admin-created Cognito account: no token yet, they
        // have to replace the emailed one-time password first.
        if (oData.passwordChangeRequired) {
          return that._openReset({ email: oData.email || sEmail, session: oData.session });
        }

        that.getOwnerComponent().onLoggedIn(oData);
      }).catch(function (oError) {
        that.byId("loginButton").setBusy(false);
        that._showError(oError.message);
      });
    },

    onForgotPassword: function () {
      this.getOwnerComponent().getRouter().navTo("forgotPassword");
    },

    _showError: function (sMessage) {
      this.byId("loginError").setText(sMessage);
      this.byId("loginError").setVisible(true);
    },

    // ===== Forgot password =====

    _onShowForgot: function () {
      this._showBlock("forgotBlock");
      this.byId("forgotMessage").setVisible(false);
      this.byId("forgotEmail").setValue("");
    },

    onSendResetLink: function () {
      var that = this;
      var sEmail = this.byId("forgotEmail").getValue().trim();

      if (!sEmail) {
        return this._showForgotMessage("Error", "Please enter your email address.");
      }

      this.byId("forgotButton").setBusy(true);

      // The reply is the same whether or not the address exists.
      auth.forgotPassword(sEmail).then(function (oData) {
        that.byId("forgotButton").setBusy(false);
        if (oData.resetWithCode) {
          // Cognito emailed a code — go straight to the code + new-password
          // screen, pre-filled with the address they just typed.
          that._openReset({ email: sEmail, code: true, message: oData.message });
        } else {
          // Local mode emailed a link — they click it, nothing more here.
          that._showForgotMessage("Success", oData.message);
        }
      }).catch(function (oError) {
        that.byId("forgotButton").setBusy(false);
        that._showForgotMessage("Error", oError.message);
      });
    },

    onBackToLogin: function () {
      this.getOwnerComponent().getRouter().navTo("login");
    },

    _showForgotMessage: function (sType, sMessage) {
      this.byId("forgotMessage").setType(sType);
      this.byId("forgotMessage").setText(sMessage);
      this.byId("forgotMessage").setVisible(true);
    },

    // ===== Reset password =====

    // Arrived from a link in an email — the token is in the URL, so there is
    // no code to type and no need to know who this is.
    _onShowReset: function (oEvent) {
      this._openReset({ token: oEvent.getParameter("arguments").token });
    },

    // The three ways into the reset block:
    //   token   - emailed link carried it in the URL (local)
    //   code    - the email held a code instead, so ask for it (needs email) (Cognito)
    //   session - a new Cognito user replacing their one-time password
    _openReset: function (oOptions) {
      this._sToken = oOptions.token || null;
      this._sEmail = oOptions.email || null;
      this._sSession = oOptions.session || null;

      this._showBlock("resetBlock");
      this.byId("resetCodeRow").setVisible(!!oOptions.code);
      this.byId("resetForm").setVisible(true);
      this.byId("goToLoginButton").setVisible(false);
      this.byId("backToLoginLink").setVisible(true);
      this.byId("resetCode").setValue("");
      this.byId("newPassword").setValue("");
      this.byId("confirmPassword").setValue("");

      if (oOptions.message) {
        this._showResetMessage("Success", oOptions.message);
      } else {
        this.byId("resetMessage").setVisible(false);
      }
    },

    onResetPassword: function () {
      var that = this;
      var sPassword = this.byId("newPassword").getValue();
      var sConfirm = this.byId("confirmPassword").getValue();

      if (sPassword.length < 8) {
        return this._showResetMessage("Error", "Password must be at least 8 characters.");
      }
      if (sPassword !== sConfirm) {
        return this._showResetMessage("Error", "Passwords do not match.");
      }

      var sCode = this.byId("resetCode").getValue().trim();
      if (this.byId("resetCodeRow").getVisible() && !sCode) {
        return this._showResetMessage("Error", "Please enter the verification code from the email.");
      }

      this.byId("resetButton").setBusy(true);

      // A session means this is a new Cognito user setting their first
      // password; everything else is a reset, by link token or emailed code.
      var oPromise = this._sSession
        ? auth.setInitialPassword({
            email: this._sEmail,
            session: this._sSession,
            password: sPassword,
            confirmPassword: sConfirm
          })
        : auth.resetPassword({
            token: this._sToken || sCode,
            email: this._sEmail,
            password: sPassword,
            confirmPassword: sConfirm
          });

      oPromise.then(function (oData) {
        that.byId("resetButton").setBusy(false);

        // Setting a first password also signs the user in — no reason to send
        // them back to the login form.
        if (oData.token) {
          return that.getOwnerComponent().onLoggedIn(oData);
        }

        that.byId("resetForm").setVisible(false);
        that.byId("backToLoginLink").setVisible(false);
        that.byId("goToLoginButton").setVisible(true);
        that._showResetMessage("Success", oData.message);
      }).catch(function (oError) {
        that.byId("resetButton").setBusy(false);
        that._showResetMessage("Error", oError.message);
      });
    },

    _showResetMessage: function (sType, sMessage) {
      this.byId("resetMessage").setType(sType);
      this.byId("resetMessage").setText(sMessage);
      this.byId("resetMessage").setVisible(true);
    }

  });
});
