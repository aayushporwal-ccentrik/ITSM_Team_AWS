sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/base/Log",
  "sap/ui/unified/ColorPickerPopover",
  "itsm/ui/model/formatter",
  "itsm/ui/model/auth",
  "itsm/ui/model/busy",
  "itsm/ui/model/createGuard"
], function (Controller, Filter, FilterOperator, MessageToast, MessageBox, Log, ColorPickerPopover, formatter, auth, busy, createGuard) {
  "use strict";

  var UPDATE_GROUP = "incidentGroup";

  // The real header displays the logo at a fixed HEIGHT only (see .appLogo/
  // .themePreviewLogo) — width scales to whatever the image's own aspect
  // ratio is. So there's no actual requirement the crop output be wide; a
  // square or tall logo just renders narrower in the header, which is fine.
  // Offering shapes instead of forcing one fixed rectangle is the direct
  // fix for "horizontal shape ki wajah se use nahi kar pa raha".
  var CROP_SHAPES = {
    WIDE: { w: 320, h: 100 },
    SQUARE: { w: 200, h: 200 },
    TALL: { w: 160, h: 220 }
  };

  var ROLE_LABELS = {
    END_USER: "End User",
    SERVICE_GROUP: "Service Group",
    CONSULTANT: "Consultant"
  };

  // ColorPickerPopover returns "rgb(r,g,b)" when a color is picked via the
  // slider/swatch area (only its own hex sub-field gives back "#rrggbb"
  // directly) — normalize to hex so storage/display/validation downstream
  // only ever have to deal with one format.
  function rgbToHex(sColor) {
    var aMatch = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(sColor || "");
    if (!aMatch) { return sColor; }
    return "#" + aMatch.slice(1, 4).map(function (sChannel) {
      var sHex = parseInt(sChannel, 10).toString(16);
      return sHex.length === 1 ? "0" + sHex : sHex;
    }).join("");
  }

  return Controller.extend("itsm.ui.controller.OrganizationDetail", {

    formatThemePreviewHtml: formatter.formatThemePreviewHtml,

    onInit: function () {
      this.getOwnerComponent().getRouter().getRoute("organizationDetail").attachPatternMatched(this._onShow, this);
    },

    _onShow: function (oEvent) {
      var sId = oEvent.getParameter("arguments").id;
      var oModel = this.getOwnerComponent().getModel();
      var oContext = oModel.bindContext("/Organizations(ID='" + sId + "')").getBoundContext();

      this.getView().setBindingContext(oContext);

      var that = this;
      oContext.requestObject().then(function (oOrg) {
        that._filterUsersByClient(oOrg.code);
      });
    },

    // Users aren't a real association to Organization (see plan — client
    // stays the same free-text match used everywhere else in the app), so
    // the table is filtered by code once the org context resolves, same
    // "set up after context loads" shape Main.controller.js already uses
    // for attachments.
    _filterUsersByClient: function (sCode) {
      this._sOrgCode = sCode;
      this.byId("orgUsersTable").getBinding("items").filter([new Filter("client", FilterOperator.EQ, sCode)]);
    },

    onBack: function () {
      this.getOwnerComponent().getRouter().navTo("organizations");
    },

    onSaveDetails: function () {
      var that = this;
      busy.withBusy(this.getView(), this.getOwnerComponent().getModel().submitBatch(UPDATE_GROUP).then(function () {
        // code may have just changed — re-read it so new users get the
        // current code, not the one this page loaded with (see _sOrgCode).
        return that.getView().getBindingContext().requestProperty("code");
      }).then(function (sCode) {
        that._filterUsersByClient(sCode);
        MessageToast.show("Organization details saved.");
      }));
    },

    onSaveTheme: function () {
      busy.withBusy(this.getView(), this.getOwnerComponent().getModel().submitBatch(UPDATE_GROUP).then(function () {
        MessageToast.show("Theme saved.");
      }));
    },

    // A picked file doesn't upload immediately — it opens the crop dialog
    // first (see onLogoCropDialogAfterOpen/_drawCrop below). This is the
    // direct fix for "logo displays too small": most logo source images
    // have far more empty margin than actual mark, so a fixed-height
    // header render (see .appLogo/.themePreviewLogo, both height:~20-30px)
    // shrinks the visible mark to almost nothing. Cropping lets the admin
    // fill the frame with just the part that should actually be shown.
    onLogoFileSelected: function (oEvent) {
      var aFiles = oEvent.getParameter("files");
      if (!aFiles || !aFiles.length) { return; }

      this._oPendingLogoFile = aFiles[0];
      this._oCropShape = CROP_SHAPES.WIDE;
      var that = this;
      var oImg = new Image();
      oImg.onload = function () {
        that._oCropImage = oImg;
        that._fCropZoom = 1;
        that._fitCropToShape();
        that.byId("logoCropShape").setSelectedKey("WIDE");
        that.byId("logoCropZoom").setValue(1);
        that.byId("logoCropDialog").open();
      };
      oImg.src = URL.createObjectURL(this._oPendingLogoFile);
    },

    onLogoCropDialogAfterOpen: function () {
      this._oCropCanvas = document.getElementById("logoCropCanvas");
      this._oCropCtx = this._oCropCanvas.getContext("2d");
      this._resizeCropCanvas();
      this._drawCrop();
      this._attachCropDragHandlers();
    },

    onLogoCropDialogAfterClose: function () {
      if (this._fnCropCleanup) { this._fnCropCleanup(); this._fnCropCleanup = null; }
      if (this._oCropImage) { URL.revokeObjectURL(this._oCropImage.src); this._oCropImage = null; }
    },

    onLogoCropShapeChange: function (oEvent) {
      this._oCropShape = CROP_SHAPES[oEvent.getParameter("key")] || CROP_SHAPES.WIDE;
      this._fCropZoom = 1;
      this.byId("logoCropZoom").setValue(1);
      this._fitCropToShape();
      this._resizeCropCanvas();
      this._drawCrop();
    },

    // Canvas width/height are attributes, not CSS — resizing via CSS alone
    // would stretch the existing bitmap instead of giving more actual pixels
    // to draw into, so the element itself is resized whenever the shape does.
    _resizeCropCanvas: function () {
      this._oCropCanvas.width = this._oCropShape.w;
      this._oCropCanvas.height = this._oCropShape.h;
    },

    // Scale "covers" the frame completely (no letterboxing) — same idea as
    // CSS object-fit:cover — then centers it. Shared by the initial file
    // load and by switching shapes later, so both fit the same way.
    _fitCropToShape: function () {
      var img = this._oCropImage;
      var oShape = this._oCropShape;
      this._fCropBaseScale = Math.max(oShape.w / img.width, oShape.h / img.height);
      this._oCropOffset = {
        x: (oShape.w - img.width * this._fCropBaseScale) / 2,
        y: (oShape.h - img.height * this._fCropBaseScale) / 2
      };
    },

    _drawCrop: function () {
      var ctx = this._oCropCtx;
      var img = this._oCropImage;
      var oShape = this._oCropShape;
      var fScale = this._fCropBaseScale * this._fCropZoom;

      ctx.clearRect(0, 0, oShape.w, oShape.h);
      ctx.drawImage(img, this._oCropOffset.x, this._oCropOffset.y, img.width * fScale, img.height * fScale);
    },

    // Plain pointer events, not a UI5 control — the canvas is raw HTML (see
    // the view), UI5 has no built-in crop/drag control to bind this to.
    _attachCropDragHandlers: function () {
      var that = this;
      var canvas = this._oCropCanvas;
      var bDragging = false;
      var oStart = null;
      var oOffsetStart = null;

      function onDown(oEvt) {
        bDragging = true;
        oStart = { x: oEvt.clientX, y: oEvt.clientY };
        oOffsetStart = { x: that._oCropOffset.x, y: that._oCropOffset.y };
      }
      function onMove(oEvt) {
        if (!bDragging) { return; }
        that._oCropOffset = {
          x: oOffsetStart.x + (oEvt.clientX - oStart.x),
          y: oOffsetStart.y + (oEvt.clientY - oStart.y)
        };
        that._drawCrop();
      }
      function onUp() { bDragging = false; }

      canvas.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);

      this._fnCropCleanup = function () {
        canvas.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
    },

    // Keeps whatever point is currently at the frame's center still at the
    // center after the zoom changes, instead of zooming from the top-left
    // corner (which would immediately drag the image out of frame).
    onLogoCropZoomChange: function (oEvent) {
      var fNewZoom = oEvent.getParameter("value");
      var oShape = this._oCropShape;
      var fOldScale = this._fCropBaseScale * this._fCropZoom;
      var fNewScale = this._fCropBaseScale * fNewZoom;
      var fFocalX = (oShape.w / 2 - this._oCropOffset.x) / fOldScale;
      var fFocalY = (oShape.h / 2 - this._oCropOffset.y) / fOldScale;

      this._fCropZoom = fNewZoom;
      this._oCropOffset = {
        x: oShape.w / 2 - fFocalX * fNewScale,
        y: oShape.h / 2 - fFocalY * fNewScale
      };
      this._drawCrop();
    },

    onApplyLogoCrop: function () {
      var that = this;
      var sMediaType = this._oPendingLogoFile.type || "image/png";
      this._oCropCanvas.toBlob(function (oBlob) {
        that.byId("logoCropDialog").close();
        that._uploadLogo(oBlob, that._oPendingLogoFile.name, sMediaType);
      }, sMediaType);
    },

    onCancelLogoCrop: function () {
      this.byId("logoCropDialog").close();
    },

    // Same upload mechanism as Main.controller.js's ticket attachments:
    // metadata (name/media type) saved first via the OData model, then the
    // raw bytes PUT directly to the LargeBinary property's own stream URL —
    // logoContent is a plain CAP media property, no custom handler needed.
    // "logo" (the field everything else reads) is only updated at the end,
    // once the upload has actually succeeded, and cache-busted with a query
    // param so re-uploading a new file doesn't keep showing the old one
    // from the browser's image cache at that same URL.
    _uploadLogo: function (oBlob, sFileName, sMediaType) {
      var oContext = this.getView().getBindingContext();
      var oModel = this.getOwnerComponent().getModel();
      var that = this;

      oContext.setProperty("logoFileName", sFileName);
      oContext.setProperty("logoMediaType", sMediaType);

      busy.withBusy(this.getView(), oModel.submitBatch(UPDATE_GROUP)
        .then(function () { return that._uploadLogoContent(oContext, oBlob, sMediaType); })
        .then(function () {
          oContext.setProperty("logo", that._getServiceUrl() + oContext.getPath().replace(/^\//, "") + "/logoContent?v=" + Date.now());
          return oModel.submitBatch(UPDATE_GROUP);
        })
        .then(function () { MessageToast.show("Logo uploaded."); })
        .catch(function (oError) {
          Log.error("Logo upload failed", oError);
          MessageToast.show("Could not upload logo.");
        }));
    },

    _uploadLogoContent: function (oContext, oBlob, sMediaType) {
      var sUrl = this._getServiceUrl() + oContext.getPath().replace(/^\//, "") + "/logoContent";
      // Raw fetch(), not the OData model, so the model's auth header doesn't apply here.
      return fetch(sUrl, {
        method: "PUT",
        headers: {
          "Content-Type": sMediaType || "image/png",
          "Authorization": "Bearer " + auth.getToken()
        },
        body: oBlob,
        credentials: "same-origin"
      }).then(function (oResponse) {
        // fetch() only rejects on a network failure, not on a 4xx/5xx status —
        // without this check a failed upload (bad CSRF token, auth, etc.) still
        // looks like a success, and "logo" gets saved pointing at a stream
        // that was never actually written — 404 the next time it's loaded.
        if (!oResponse.ok) { throw new Error("Upload failed with status " + oResponse.status); }
        return oResponse;
      });
    },

    _getServiceUrl: function () {
      // The model's own resolved URL, not the raw manifest.json string — Work Zone
      // runs the app inside cp.portal's own document, so a manually-built relative
      // string resolves against the wrong base. The bound model already resolved
      // this correctly via UI5's resource-root mapping.
      var sUrl = this.getOwnerComponent().getModel().sServiceUrl;
      return sUrl.replace(/\/?$/, "/");
    },

    onRemoveLogo: function () {
      var oContext = this.getView().getBindingContext();
      oContext.setProperty("logo", null);
      this.getOwnerComponent().getModel().submitBatch(UPDATE_GROUP);
    },

    // One popover reused for both fields, opened by whichever palette
    // button was pressed — colorString is only read on open (to seed the
    // picker) and written back through the same bound field on change, so
    // the live preview updates immediately without a separate "apply" step.
    // The change handler re-reads the view's binding context each time
    // (not captured once) — this popover instance outlives a single org,
    // so a stale captured context would misfire after navigating org A's
    // detail page -> org B's.
    _openColorPicker: function (oButton, sField) {
      var that = this;
      var oContext = this.getView().getBindingContext();

      if (!this._oColorPopover) {
        this._oColorPopover = new ColorPickerPopover({
          change: function (oEvent) {
            that.getView().getBindingContext().setProperty(that._sColorField, rgbToHex(oEvent.getParameter("colorString")));
          }
        });
      }
      this._sColorField = sField;
      this._oColorPopover.setColorString(oContext.getProperty(sField) || "#2a78d6");
      this._oColorPopover.openBy(oButton);
    },

    onPickPrimaryColor: function (oEvent) {
      this._openColorPicker(oEvent.getSource(), "primaryColor");
    },

    onPickSecondaryColor: function (oEvent) {
      this._openColorPicker(oEvent.getSource(), "secondaryColor");
    },

    onPickNewTicketBtnColor: function (oEvent) {
      this._openColorPicker(oEvent.getSource(), "newTicketBtnColor");
    },

    onPickNewTicketBtnTextColor: function (oEvent) {
      this._openColorPicker(oEvent.getSource(), "newTicketBtnTextColor");
    },

    onPickFormBtnColor: function (oEvent) {
      this._openColorPicker(oEvent.getSource(), "formBtnColor");
    },

    onPickFormBtnTextColor: function (oEvent) {
      this._openColorPicker(oEvent.getSource(), "formBtnTextColor");
    },

    onUserRoleChange: function () {
      busy.withBusy(this.getView(), this.getOwnerComponent().getModel().submitBatch(UPDATE_GROUP).then(function () {
        MessageToast.show("Role updated.");
      }));
    },

    onToggleUserActive: function () {
      busy.withBusy(this.getView(), this.getOwnerComponent().getModel().submitBatch(UPDATE_GROUP).then(function () {
        MessageToast.show("Status updated.");
      }));
    },

    formatRoleLabel: function (sRole) {
      return ROLE_LABELS[sRole] || sRole;
    },

    onDeleteUser: function (oEvent) {
      var that = this;
      var oContext = oEvent.getSource().getBindingContext();
      var sName = oContext.getProperty("name");

      MessageBox.confirm("Delete user \"" + sName + "\"? This cannot be undone.", {
        onClose: function (sAction) {
          if (sAction !== MessageBox.Action.OK) { return; }
          var oModel = that.getOwnerComponent().getModel();
          var pDeleted = oContext.delete(UPDATE_GROUP);
          oModel.submitBatch(UPDATE_GROUP);
          busy.withBusy(that.getView(), pDeleted.then(function () {
            MessageToast.show("User deleted.");
          }).catch(function (oError) {
            Log.error("User delete failed", oError);
            MessageBox.error("Could not delete the user.");
          }));
        }
      });
    },

    // Same dialog for both — _oEditUserContext is null in create mode, set
    // to the row's context in edit mode. onSaveUser branches on that.
    onAddUser: function () {
      this._oEditUserContext = null;
      this.byId("newUserEmail").setValue("");
      this.byId("newUserEmail").setEnabled(true);
      this.byId("newUserName").setValue("");
      this.byId("newUserRoles").setSelectedKeys(["END_USER"]);
      this.byId("newUserActive").setState(true);
      this.byId("addUserDialog").setTitle("Add User");
      this.byId("userDialogSaveBtn").setText("Create");
      this.byId("addUserDialog").open();
    },

    // Email is locked here, not just pre-filled: it doubles as userId (see
    // dialog note), which for a real BTP login has to exactly match
    // req.user.id, and for a local mocked user is a fixed string from
    // package.json — either way, nothing an edit here should be able to
    // silently move. Set once at creation, fixed after. Wrong email typed
    // at creation → delete and re-add, not edit.
    onEditUser: function (oEvent) {
      var oContext = oEvent.getSource().getBindingContext();
      this._oEditUserContext = oContext;
      this.byId("newUserEmail").setValue(oContext.getProperty("email"));
      this.byId("newUserEmail").setEnabled(false);
      this.byId("newUserName").setValue(oContext.getProperty("name"));
      this.byId("newUserActive").setState(oContext.getProperty("isActive"));
      this.byId("addUserDialog").setTitle("Edit User");
      this.byId("userDialogSaveBtn").setText("Save");
      this.byId("addUserDialog").open();

      // Roles live in their own rows, so they come from a separate read.
      var that = this;
      this._readUserRoles(oContext.getProperty("userId")).then(function (aRoles) {
        that.byId("newUserRoles").setSelectedKeys(aRoles.length ? aRoles : [oContext.getProperty("role")]);
      });
    },

    _readUserRoles: function (sUserId) {
      return this.getOwnerComponent().getModel().bindList("/UserRoles", undefined, undefined, undefined, {
        $filter: "userId eq '" + sUserId + "'"
      }).requestContexts().then(function (aContexts) {
        return aContexts.map(function (oCtx) { return oCtx.getProperty("role"); });
      });
    },

    // Adds the roles that were ticked and removes the ones that weren't.
    // Rows that are already right are left alone.
    _syncUserRoles: function (sUserId, aRoles) {
      var oModel = this.getOwnerComponent().getModel();

      return oModel.bindList("/UserRoles", undefined, undefined, undefined, {
        $filter: "userId eq '" + sUserId + "'"
      }).requestContexts().then(function (aContexts) {
        var aExisting = aContexts.map(function (oCtx) { return oCtx.getProperty("role"); });

        aContexts.forEach(function (oCtx) {
          if (aRoles.indexOf(oCtx.getProperty("role")) === -1) { oCtx.delete(UPDATE_GROUP); }
        });

        // Same group as the deletes, so submitBatch(UPDATE_GROUP) below sends both.
        var oListBinding = oModel.bindList("/UserRoles", undefined, undefined, undefined, { $$groupId: UPDATE_GROUP });
        aRoles.forEach(function (sRole) {
          if (aExisting.indexOf(sRole) === -1) {
            createGuard.guard(oListBinding, oListBinding.create({ userId: sUserId, role: sRole }), null);
          }
        });

        // create()/delete() only queue on the batch group — this is what sends them.
        return oModel.submitBatch(UPDATE_GROUP);
      });
    },

    onResendPasswordSetup: function (oEvent) {
      var oButton = oEvent.getSource();
      var sUserId = oButton.getBindingContext().getProperty("userId");
      var oAction = this.getOwnerComponent().getModel().bindContext("/sendPasswordSetup(...)");

      oAction.setParameter("userId", sUserId);
      busy.withBusy(oButton, oAction.execute().then(function () {
        MessageToast.show(oAction.getBoundContext().getValue());
      }).catch(function (oError) {
        Log.error("Password setup link failed", oError);
        MessageToast.show("Could not send the password setup link.");
      }));
    },

    onSaveUser: function () {
      var sEmail = this.byId("newUserEmail").getValue().trim();
      var sName = this.byId("newUserName").getValue().trim();
      if (!sName || (!this._oEditUserContext && !sEmail)) {
        MessageToast.show("Email and Name are required.");
        return;
      }

      var aRoles = this.byId("newUserRoles").getSelectedKeys();
      if (!aRoles.length) {
        MessageToast.show("Please select at least one role.");
        return;
      }

      // User.role stays the primary/default one; UserRole rows are what
      // login actually reads.
      var sRole = aRoles[0];
      var bActive = this.byId("newUserActive").getState();
      var oModel = this.getOwnerComponent().getModel();
      var that = this;

      var oDialog = this.byId("addUserDialog");

      if (this._oEditUserContext) {
        var sEditUserId = this._oEditUserContext.getProperty("userId");
        this._oEditUserContext.setProperty("name", sName);
        this._oEditUserContext.setProperty("role", sRole);
        this._oEditUserContext.setProperty("isActive", bActive);
        busy.withBusy(oDialog, oModel.submitBatch(UPDATE_GROUP).then(function () {
          return that._syncUserRoles(sEditUserId, aRoles);
        }).then(function () {
          oDialog.close();
          MessageToast.show("User updated.");
          that._oEditUserContext = null;
        }).catch(function (oError) {
          Log.error("User update failed", oError);
          MessageToast.show("Could not update user.");
        }));
        return;
      }

      var oListBinding = oModel.bindList("/Users");
      var oContext = oListBinding.create({
        userId: sEmail,
        name: sName,
        email: sEmail,
        role: sRole,
        isActive: bActive,
        client: this._sOrgCode
      });

      oDialog.setBusy(true);
      createGuard.guard(oListBinding, oContext, oDialog);

      oContext.created().then(function () {
        // The backend already added the primary role and emailed the setup
        // link (srv/service.js after CREATE Users) — this adds the rest.
        return that._syncUserRoles(sEmail, aRoles);
      }).then(function () {
        oDialog.setBusy(false);
        oDialog.close();
        MessageToast.show("User created. A password setup link has been emailed to them.");
        that.byId("orgUsersTable").getBinding("items").refresh();
      }).catch(function (oError) {
        if (oError.canceled) { return; } // already handled above, by our own delete()
        oDialog.setBusy(false);
        Log.error("User create failed", oError);
        MessageBox.error(oError.message || "Could not create user.");
      });

      // Same miss as Organizations.controller.js's onSaveOrganization had:
      // create() only queues the request, submitBatch is what actually
      // sends it — without this the Create button silently does nothing.
      oModel.submitBatch(UPDATE_GROUP);
    },

    onCancelUserDialog: function () {
      this._oEditUserContext = null;
      this.byId("addUserDialog").close();
    }
  });
});
