sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/base/Log",
  "itsm/ui/model/roleConfig",
  "itsm/ui/model/formatter",
  "itsm/ui/model/lookupValues",
  "itsm/ui/model/auth",
  "itsm/ui/model/busy",
  "itsm/ui/model/createGuard"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, Log, getTicketFormUiModel, formatter, fetchLookup, auth, busy, createGuard) {
  "use strict";

  var UPDATE_GROUP = "incidentGroup";

  // oFile.type (browser MIME sniffing) is unreliable for Office documents:
  // legacy .doc is frequently reported as "" and .docx (a zip container) can
  // come back as "" or "application/zip" on systems without those types
  // registered. Fall back to extension-based lookup covering the formats
  // this form already advertises as supported.
  var EXTENSION_MIME_TYPES = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    eml: "message/rfc822",
    msg: "application/vnd.ms-outlook"
  };

  return Controller.extend("itsm.ui.controller.Main", {

    onInit: function () {
      this.getView().setModel(new JSONModel({}), "ui");
      this.getView().setModel(new JSONModel({ list: [], countLabel: "0 files" }), "attachments");

      var oRouter = this.getOwnerComponent().getRouter();
      oRouter.getRoute("create").attachPatternMatched(this._onCreate, this);
      oRouter.getRoute("detail").attachPatternMatched(this._onDetail, this);
    },

    // Starts a brand new ticket as a Draft. Nothing is sent to the server
    // yet — the model's updateGroupId is a named batch group (see
    // manifest.json), so the create just sits in the local cache until
    // Save (or Submit) sends it. The server assigns ticketID and
    // ticketNumber on insert (see srv/service.js), not the client.
    _onCreate: function () {
      // If this route matches again before a previous visit's create was
      // ever saved (e.g. "New Ticket" pressed twice, or navigating back to
      // /create), the earlier context is still sitting in the same batch
      // group, still transient (never sent). Left alone, it rides along on
      // the NEXT submitBatch (Save/Submit) as a second, blank ticket — the
      // form only shows the latest context, so that first one silently
      // saves with whatever it had at creation time (i.e. nothing typed
      // yet, not even a ticket type) instead of what the user actually
      // filled in. Discarding it here means at most one pending create
      // ever exists at a time.
      if (this._oPendingCreateContext && this._oPendingCreateContext.isTransient()) {
        this._oPendingCreateContext.delete();
      }

      this._bCreateMode = true;
      this._bEditing = true;
      this._ensureTicketTypeNames();

      var oListBinding = this.getView().getModel().bindList("/Tickets");
      var oContext = oListBinding.create({
        status: "DRAFT",
        // Picked in the "New Ticket" popup on the Dashboard, before this
        // route even opens — not a field on this form anymore.
        ticketType: this.getOwnerComponent().takePendingTicketType(),
        reportedBy: this._getUserName(),
        incidentForm: {}
      });
      // Fires whenever Save/Submit actually sends this — see createGuard.js
      // for why created().catch() alone can't be trusted for this.
      createGuard.guard(oListBinding, oContext, this.getView());
      this._oPendingCreateContext = oContext;

      this.getView().setBindingContext(oContext);
      this.getView().getModel("attachments").setData({ list: [], countLabel: "0 files" });
      this._refreshUiModel("DRAFT");
    },

    _onDetail: function (oEvent) {
      this._bCreateMode = false;
      this._bEditing = false;
      this._ensureTicketTypeNames();
      this._loadTicket(oEvent.getParameter("arguments").id);
    },

    // Fetched once, reused by the header title's formatter (see
    // formatTicketTypeName) so it shows "Incident"/"Service Request"/...
    // instead of the raw code.
    _ensureTicketTypeNames: function () {
      if (this._mTicketTypeName) { return; }
      this._mTicketTypeName = {};
      var that = this;
      fetchLookup(this.getOwnerComponent().getModel(), "TICKETTYPE").then(function (aRows) {
        aRows.forEach(function (r) { that._mTicketTypeName[r.code] = r.name; });
      });
    },

    formatTicketTypeName: function (sCode) {
      return (this._mTicketTypeName && this._mTicketTypeName[sCode]) || "Service Desk";
    },

    // One request for the ticket, its incident form and its attachments —
    // the composition is already in the schema, so $expand gets everything
    // the form needs in one round trip instead of a separate attachments call.
    // Also used after a lifecycle action (Submit/Assign/Resolve/Close)
    // completes, to pick up the new status/pendingWith it set server-side.
    _loadTicket: function (sId) {
      var oContext = this.getView().getModel().bindContext(
        "/Tickets(ticketID='" + sId + "')",
        undefined,
        { $expand: "incidentForm,attachments,reportedByUser" }
      ).getBoundContext();

      this.getView().setBindingContext(oContext);

      var that = this;
      return oContext.requestObject().then(function (oTicket) {
        that._refreshUiModel(oTicket.status);
        that._setAttachmentsModel(oTicket.attachments, oContext);
        that._scopeConsultantPicker(oTicket.reportedByUser && oTicket.reportedByUser.client);
        if (that.getView().getModel("ui").getProperty("/showReminder")) {
          return that._refreshReminderStatus(sId);
        }
      });
    },

    // Assign picker only offers Consultants from the reporter's own org —
    // a blank org (ccentrik-wide staff) leaves the list unrestricted, same
    // as the backend's org-scoping for Service Group/Consultant (service.js).
    _scopeConsultantPicker: function (sClient) {
      var oSelect = this.byId("messageProcessorSelect");
      if (!oSelect) { return; }
      var oBinding = oSelect.getBinding("items");
      if (!oBinding) { return; }
      oBinding.filter(sClient ? [new Filter("client", FilterOperator.EQ, sClient)] : []);
    },

    // Bell's enabled state + tooltip, refreshed whenever the ticket
    // (re)loads — cooldown state is visible up front, not just discovered
    // by clicking and getting a 429 back.
    _refreshReminderStatus: function (sId) {
      var that = this;
      // "(...)" + setParameter(), not the value baked into the path — execute() needs a deferred binding.
      var oOperation = this.getView().getModel().bindContext("/reminderStatus(...)");
      oOperation.setParameter("ticketID", sId);
      return oOperation.execute().then(function () {
        var oResult = oOperation.getBoundContext().getObject();
        var oUiModel = that.getView().getModel("ui");
        oUiModel.setProperty("/reminderEnabled", !!oResult.enabled);
        oUiModel.setProperty("/reminderTooltip", oResult.enabled
          ? "Send a reminder"
          : "On cooldown until " + new Date(oResult.nextAllowedAt).toLocaleString());
      });
    },

    onReminder: function () {
      var that = this;
      var sTicketId = this.getView().getBindingContext().getProperty("ticketID");
      var oOperation = this.getView().getModel().bindContext("/sendReminder(...)");
      oOperation.setParameter("ticketID", sTicketId);

      this._withBusy(oOperation.execute().then(function () {
        MessageToast.show("Reminder sent.");
        return that._refreshReminderStatus(sTicketId);
      }).catch(function (oError) {
        Log.error("sendReminder failed", oError);
        MessageBox.error(that._actionErrorText(oError) || "Could not send the reminder.");
      }));
    },

    // Persona comes from the server (see Component.js / srv/service.js
    // currentUser()). The actual role → flags mapping lives in
    // model/roleConfig.js, not here — this just feeds it the current
    // state and stores the result.
    _refreshUiModel: function (sStatus) {
      var sPersona = this.getOwnerComponent().getModel("role").getProperty("/persona");
      var oContext = this.getView().getBindingContext();
      // A brand new ticket's context stays transient (isTransient() true)
      // until the server confirms the create — status is already "DRAFT"
      // locally from the moment the form opens, so bDraft alone would show
      // Delete before there's anything on the server yet to delete.
      var bPersisted = !!oContext && !oContext.isTransient();
      var oUiModel = getTicketFormUiModel(sPersona, !!this._bCreateMode, !!this._bEditing, sStatus, bPersisted);
      this.getView().getModel("ui").setData(oUiModel);
    },

    onEdit: function () {
      this._bEditing = true;
      this._refreshUiModel(this.getView().getBindingContext().getProperty("status"));
    },

    _withBusy: function (pAction) {
      return busy.withBusy(this.getView(), pAction);
    },

    // First save of a brand new ticket creates it as Draft and shows the
    // generated ticket number; saving an already-open ticket (Service
    // Group / Consultant editing) just persists the changes.
    onSave: function () {
      var that = this;
      var oContext = this.getView().getBindingContext();
      var bWasCreating = this._bCreateMode;

      var pSaved = this.getView().getModel().submitBatch(UPDATE_GROUP);
      if (bWasCreating) {
        pSaved = pSaved.then(function () { return oContext.created(); });
      }

      this._withBusy(pSaved.then(function () {
        if (bWasCreating) {
          that._oPendingCreateContext = null;
          var sNumber = oContext.getProperty("ticketNumber");
          // Stay on this same context (still in create mode) instead of
          // navigating to the detail page — that would flip _bCreateMode
          // off and lock every field, even though the user might still
          // want to keep filling the form in. Only Submit should lock it.
          MessageBox.information("Ticket " + sNumber + " has been created and saved as Draft.", {
            onClose: function () {
              that._navHome();
            }
          });
        } else {
          that._bEditing = false;
          that._refreshUiModel(oContext.getProperty("status"));
          MessageToast.show("Ticket saved");
        }
      }).catch(function (oError) {
        if (oError.canceled) { return; } // already shown by createGuard
        // Logged, not just shown as a generic toast — otherwise "request
        // never sent" and "request sent, server rejected it" look identical
        // from the outside, which is exactly what made an earlier bug here
        // hard to pin down.
        Log.error("Ticket save failed", oError);
        MessageBox.error("Could not save the ticket. Please check the required fields.");
      }));
    },

    // Moves the ticket straight to New — either a brand new ticket that
    // was never saved as Draft, or an existing Draft opened later. A brand
    // new ticket has to be created first (it has no ticketID yet); an
    // existing Draft is already saved, so that step is skipped. Either way
    // it ends at the same place: ticketAction("SUBMIT") does the actual
    // status change and workflow log (see srv/service.js).
    onSubmit: function () {
      var that = this;
      var oContext = this.getView().getBindingContext();
      var bWasCreating = this._bCreateMode;

      var pReady = this.getView().getModel().submitBatch(UPDATE_GROUP);
      if (bWasCreating) {
        pReady = pReady.then(function () { return oContext.created(); });
      }

      this._withBusy(pReady.then(function () {
        if (bWasCreating) { that._oPendingCreateContext = null; }
        return that._invokeTicketAction(oContext.getProperty("ticketID"), "SUBMIT");
      }).then(function () {
        MessageBox.success("Your ticket has been submitted.", {
          onClose: function () { that._navHome(); }
        });
      }).catch(function (oError) {
        if (oError.canceled) { return; } // already shown by createGuard
        Log.error("Ticket submit failed", oError);
        MessageBox.error(that._actionErrorText(oError) || "Could not submit the ticket. Please check the required fields.");
      }));
    },

    // Service Group assigning a Consultant, Consultant marking their work
    // resolved, End User closing a resolved ticket — same shape as Submit
    // above: save whatever's pending (e.g. the Consultant just picked),
    // then run that one ticketAction. Nothing here re-implements the
    // status/workflow-log logic — that's all in srv/service.js.
    onAssign: function () {
      this._runLifecycleAction("ASSIGN", "Could not assign the ticket.");
    },

    onResolve: function () {
      this._runLifecycleAction("RESOLVED", "Could not mark the ticket resolved.");
    },

    onClose: function () {
      this._runLifecycleAction("CLOSED", "Could not close the ticket.");
    },

    _runLifecycleAction: function (sAction, sErrorFallback) {
      var that = this;
      var oModel = this.getView().getModel();
      var oContext = this.getView().getBindingContext();
      var sTicketId = oContext.getProperty("ticketID");

      // ASSIGN is the only action that depends on a field the user has just
      // filled in, and the server can only see it once it is saved. Check it
      // here so an empty dropdown says so plainly, instead of the server
      // reporting "no consultant" for a value the user can see on screen.
      if (sAction === "ASSIGN" && !oContext.getProperty("messageProcessor")) {
        MessageBox.error("Please select a Message Processor before assigning the ticket.");
        return;
      }

      this._withBusy(oModel.submitBatch(UPDATE_GROUP).then(function () {
        // submitBatch() resolves even when a request inside the batch was
        // rejected, so leftover pending changes are the only reliable sign
        // that the save never reached the server. Without this the action
        // runs against stale data and fails with a misleading message.
        if (oModel.hasPendingChanges(UPDATE_GROUP)) {
          throw new Error("The ticket could not be saved, so the action was not performed.");
        }
        that._bEditing = false;
        return that._invokeTicketAction(sTicketId, sAction);
      }).then(function (sMessage) {
        MessageToast.show(sMessage);
      }).catch(function (oError) {
        Log.error("ticketAction " + sAction + " failed", oError);
        MessageBox.error(that._actionErrorText(oError) || sErrorFallback);
      }));
    },

    // Calls the ticketAction OData action, then reloads the ticket so the
    // form picks up whatever it changed (status, subStatus, pendingWith).
    _invokeTicketAction: function (sTicketId, sAction) {
      var that = this;
      var oOperation = this.getView().getModel().bindContext("/ticketAction(...)");
      oOperation.setParameter("ticketID", sTicketId);
      oOperation.setParameter("action", sAction);

      return oOperation.execute().then(function () {
        return oOperation.getBoundContext().getProperty("value");
      }).then(function (sMessage) {
        return that._loadTicket(sTicketId).then(function () { return sMessage; });
      });
    },

    // ticketAction sends back a plain, readable message (e.g. "No
    // Consultant selected for this ticket.") — show that instead of a
    // generic error when we have it.
    _actionErrorText: function (oError) {
      return oError && oError.message;
    },

    onDelete: function () {
      var that = this;
      MessageBox.confirm("Delete this ticket? This cannot be undone.", {
        onClose: function (sAction) {
          if (sAction !== MessageBox.Action.OK) { return; }
          var oModel = that.getView().getModel();
          var pDeleted = that.getView().getBindingContext().delete(UPDATE_GROUP);
          // delete() only queues the request on incidentGroup — it's an API
          // group (see manifest.json), so nothing is actually sent until
          // submitBatch flushes it, same as onSave/onSubmit already do.
          oModel.submitBatch(UPDATE_GROUP);
          that._withBusy(pDeleted.then(function () {
            MessageToast.show("Ticket deleted");
            that.getOwnerComponent().getRouter().navTo("dashboard");
          }).catch(function (oError) {
            Log.error("Ticket delete failed", oError);
            MessageBox.error("Could not delete the ticket.");
          }));
        }
      });
    },

    onBack: function () {
      this._navHome();
    },

    onGoDashboard: function () {
      this._navHome();
    },

    // Consultant's home is their own assigned queue, not the shared dashboard.
    _navHome: function () {
      var sPersona = this.getOwnerComponent().getModel("role").getProperty("/persona");
      var sRoute = sPersona === "CONSULTANT" ? "assigned" : "dashboard";
      this.getOwnerComponent().getRouter().navTo(sRoute);
    },

    // Sub Status belongs to whichever Status is picked now, so drop the old
    // one whenever Status changes instead of leaving a stale pairing.
    onStatusChange: function () {
      this.getView().getBindingContext().setProperty("subStatus", null);
    },

    onTabSelect: function (oEvent) {
      var oSectionByKey = {
        general: "secGeneral",
        processing: "secProcessing",
        relationships: "secRelationships",
        attachments: "secAttachments"
      };
      var oSection = this.byId(oSectionByKey[oEvent.getParameter("key")]);
      if (oSection && oSection.getDomRef()) {
        oSection.getDomRef().scrollIntoView({ behavior: "smooth" });
      }
    },

    onFileSelected: function (oEvent) {
      var aFiles = Array.prototype.slice.call(oEvent.getParameter("files") || []);
      if (!aFiles.length) { return; }

      var oTicketContext = this.getView().getBindingContext();
      var oModel = this.getView().getModel();
      var that = this;

      // oAttContext.created() never resolves for an attachment created while
      // the parent Ticket is itself still unsaved (deep-insert case) — the
      // child gets folded into the parent's single create request instead of
      // getting one of its own, and afterwards its context keeps a stale
      // transient ($uid=...) identity that fails to drill down for any
      // property. Wait on the batch itself, then read the real, server-
      // assigned IDs back off oTicketContext (a plain top-level property
      // read, which does resolve correctly) instead of the child context.
      aFiles.forEach(function (oFile) {
        oModel.bindList("attachments", oTicketContext).create({
          fileName: oFile.name,
          mediaType: that._resolveMimeType(oFile),
          fileSize: oFile.size
        });
      });

      oModel.submitBatch(UPDATE_GROUP).then(function () {
        var sTicketId = oTicketContext.getProperty("ticketID");
        var aSaved = (oTicketContext.getObject() || {}).attachments || [];
        aFiles.forEach(function (oFile) {
          var oSaved = aSaved.filter(function (o) {
            return o.fileName === oFile.name && o.fileSize === oFile.size;
          }).pop();
          if (!oSaved) {
            MessageBox.error("Could not upload " + oFile.name + ".");
            return;
          }
          that._uploadContent(sTicketId, oSaved.ID, oFile)
            .then(function () { that._refreshAttachments(oTicketContext); })
            .catch(function () { MessageBox.error("Could not upload " + oFile.name + "."); });
        });
      });
    },

    // Attachment is only reachable through the Ticket's "attachments" nav
    // property (CAP rejects a direct top-level path to it), so the delete
    // path has to be built relative to the ticket context, not absolute.
    // <Link href> can't carry the Authorization header, so fetch() + Blob URL instead.
    onDownloadAttachment: function (oEvent) {
      var oContext = oEvent.getSource().getBindingContext("attachments");
      var sUrl = oContext.getProperty("contentUrl");
      var sFileName = oContext.getProperty("fileName");

      fetch(sUrl, { headers: { "Authorization": "Bearer " + auth.getToken() } })
        .then(function (oResponse) {
          if (!oResponse.ok) { throw new Error("Download failed with status " + oResponse.status); }
          return oResponse.blob();
        })
        .then(function (oBlob) {
          var sObjectUrl = URL.createObjectURL(oBlob);
          var oLink = document.createElement("a");
          oLink.href = sObjectUrl;
          oLink.download = sFileName || "attachment";
          document.body.appendChild(oLink);
          oLink.click();
          document.body.removeChild(oLink);
          URL.revokeObjectURL(sObjectUrl);
        })
        .catch(function (oError) {
          Log.error("Attachment download failed", oError);
          MessageToast.show("Could not download the attachment.");
        });
    },

    onAttachmentRemove: function (oEvent) {
      var sId = oEvent.getSource().getBindingContext("attachments").getProperty("id");
      var oTicketContext = this.getView().getBindingContext();
      var oModel = this.getView().getModel();
      var that = this;

      var pDeleted = oModel.bindContext("attachments(ID='" + sId + "')", oTicketContext).getBoundContext().delete(UPDATE_GROUP);
      oModel.submitBatch(UPDATE_GROUP);
      pDeleted
        .then(function () { that._refreshAttachments(oTicketContext); })
        .catch(function (oError) {
          Log.error("Attachment remove failed", oError);
          MessageBox.error("Could not remove the attachment.");
        });
    },

    // Re-reads the attachments list after an upload or a remove. This one
    // is a real extra request (the data just changed), unlike the initial
    // load which comes for free via $expand in _onDetail.
    _refreshAttachments: function (oTicketContext) {
      var that = this;
      this.getView().getModel().bindList("attachments", oTicketContext).requestContexts()
        .then(function (aContexts) {
          that._setAttachmentsModel(aContexts.map(function (oCtx) { return oCtx.getObject(); }), oTicketContext);
        });
    },

    _setAttachmentsModel: function (aAttachments, oTicketContext) {
      var that = this;
      var sBase = this._getServiceUrl() + oTicketContext.getPath().replace(/^\//, "") + "/attachments";

      var aList = (aAttachments || []).map(function (oAtt) {
        return {
          id: oAtt.ID,
          fileName: oAtt.fileName,
          uploadedBy: oAtt.createdBy,
          uploadedOn: that.formatDateTime(oAtt.createdAt),
          contentUrl: sBase + "(ID='" + oAtt.ID + "')/content"
        };
      });

      this.getView().getModel("attachments").setData({
        list: aList,
        countLabel: aList.length + (aList.length === 1 ? " file" : " files")
      });
    },

    _uploadContent: function (sTicketId, sAttId, oFile) {
      var sUrl = this._getServiceUrl() + "Tickets('" + encodeURIComponent(sTicketId) + "')/attachments(ID='" + sAttId + "')/content";
      // Raw fetch(), not the OData model, so the model's auth header doesn't apply here.
      return fetch(sUrl, {
        method: "PUT",
        headers: {
          "Content-Type": this._resolveMimeType(oFile),
          "Authorization": "Bearer " + auth.getToken()
        },
        body: oFile,
        credentials: "same-origin"
      }).then(function (oResponse) {
        // fetch() only rejects on a network failure, not on a 4xx/5xx status —
        // without this check a failed upload (bad CSRF token, auth, etc.)
        // looks identical to a successful one to every caller.
        if (!oResponse.ok) { throw new Error("Upload failed with status " + oResponse.status); }
        return oResponse;
      });
    },

    _resolveMimeType: function (oFile) {
      if (oFile.type) { return oFile.type; }
      var sExt = (oFile.name.split(".").pop() || "").toLowerCase();
      return EXTENSION_MIME_TYPES[sExt] || "application/octet-stream";
    },

    _getServiceUrl: function () {
      return this.getOwnerComponent().getManifestEntry("sap.app").dataSources.incidentService.uri;
    },

    _getUserName: function () {
      return this.getOwnerComponent().getModel("role").getProperty("/userName");
    },

    formatDateTime: formatter.formatDateTime,

    // No real SLA target data exists yet (priority has no defined response
    // time), so this just reflects where the ticket is in its lifecycle.
    formatSlaText: function (sPriority, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      if (sCompletedAt) { return "Completed"; }
      if (sFirstResponseAt) { return "First response given"; }
      return sPriority ? "Awaiting first response" : "Awaiting assessment";
    },

    formatSlaState: function (sPriority, sCreatedAt, sFirstResponseAt, sCompletedAt) {
      if (sCompletedAt) { return "Success"; }
      if (sFirstResponseAt) { return "Warning"; }
      return "None";
    }
  });
});
