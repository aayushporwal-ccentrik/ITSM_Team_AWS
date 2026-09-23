sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/base/Log",
  "itsm/ui/model/userMenu",
  "itsm/ui/model/createGuard"
], function (Controller, JSONModel, MessageToast, MessageBox, Log, userMenu, createGuard) {
  "use strict";

  var UPDATE_GROUP = "incidentGroup";

  return Controller.extend("itsm.ui.controller.Organizations", {
    // Header account popover: current role, role switch, logout.
    onUserMenu: function (oEvent) {
      userMenu.open(this, oEvent.getSource());
    },

    onInit: function () {
      this.getOwnerComponent().getRouter().getRoute("organizations").attachPatternMatched(this._onShow, this);
    },

    _onShow: function () {
      this._sSearch = "";
      this._sStatus = "ALL";
      this._loadOrganizations();
    },

    // One read for orgs, one small read for users (just to count them per
    // client) — same "load once, derive counts client-side" shape the
    // Service Group Dashboard already uses for its own client/ticket split.
    _loadOrganizations: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();

      Promise.all([
        oModel.bindList("/Organizations", undefined, undefined, undefined, {
          $select: "ID,code,name,isActive",
          $orderby: "name"
        }).requestContexts(),
        oModel.bindList("/Users", undefined, undefined, undefined, { $select: "client" }).requestContexts()
      ]).then(function (aResults) {
        var aOrgs = aResults[0].map(function (oCtx) { return oCtx.getObject(); });
        var aUsers = aResults[1].map(function (oCtx) { return oCtx.getObject(); });

        var mCountByClient = {};
        aUsers.forEach(function (u) {
          if (u.client) { mCountByClient[u.client] = (mCountByClient[u.client] || 0) + 1; }
        });

        that._aAllOrgs = aOrgs.map(function (o) {
          return {
            ID: o.ID,
            name: o.name,
            code: o.code,
            isActive: o.isActive,
            userCount: mCountByClient[o.code] || 0
          };
        });
        that._applyFilters();
      });
    },

    _applyFilters: function () {
      var sSearch = (this._sSearch || "").toLowerCase();
      var sStatus = this._sStatus || "ALL";

      var aFiltered = (this._aAllOrgs || []).filter(function (o) {
        var bMatchesStatus = sStatus === "ALL" || (sStatus === "ACTIVE") === !!o.isActive;
        var bMatchesSearch = !sSearch ||
          o.name.toLowerCase().indexOf(sSearch) !== -1 ||
          o.code.toLowerCase().indexOf(sSearch) !== -1;
        return bMatchesStatus && bMatchesSearch;
      });

      this.getView().setModel(new JSONModel({ organizations: aFiltered }), "orgs");
    },

    onSearch: function (oEvent) {
      this._sSearch = oEvent.getParameter("query") || oEvent.getParameter("newValue") || "";
      this._applyFilters();
    },

    onFilterChange: function (oEvent) {
      this._sStatus = oEvent.getSource().getSelectedKey();
      this._applyFilters();
    },

    onAddOrganization: function () {
      this.byId("newOrgName").setValue("");
      this.byId("newOrgCode").setValue("");
      this.byId("addOrgDialog").open();
    },

    onSaveOrganization: function () {
      var sName = this.byId("newOrgName").getValue().trim();
      var sCode = this.byId("newOrgCode").getValue().trim();
      if (!sName || !sCode) {
        MessageToast.show("Name and Code are required.");
        return;
      }

      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oDialog = this.byId("addOrgDialog");
      var oListBinding = oModel.bindList("/Organizations");
      var oContext = oListBinding.create({ name: sName, code: sCode });

      oDialog.setBusy(true);
      createGuard.guard(oListBinding, oContext, oDialog);

      oContext.created().then(function () {
        oDialog.setBusy(false);
        oDialog.close();
        MessageToast.show("Organization created.");
        that._loadOrganizations();
      }).catch(function (oError) {
        if (oError.canceled) { return; } // already shown by createGuard
        oDialog.setBusy(false);
        Log.error("Organization create failed", oError);
        MessageBox.error(oError.message || "Could not create organization.");
      });

      // create() only queues the request on this batch group — nothing is
      // actually sent until submitBatch flushes it (same as everywhere else
      // in this app that creates something). Missing this is exactly why
      // the button looked like it did nothing: .created() never resolves
      // because the request was never dispatched.
      oModel.submitBatch(UPDATE_GROUP);
    },

    onCancelAddOrganization: function () {
      this.byId("addOrgDialog").close();
    },

    onOpenOrganization: function (oEvent) {
      var sId = oEvent.getSource().getBindingContext("orgs").getProperty("ID");
      this.getOwnerComponent().getRouter().navTo("organizationDetail", { id: sId });
    }
  });
});
