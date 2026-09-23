sap.ui.define(["sap/m/MessageBox"], function (MessageBox) {
  "use strict";

  // A create() that fails server-side (e.g. a duplicate/constraint error) never
  // rejects created()'s promise inside an API batch group — UI5 just keeps the
  // row pending to resend later ("will be repeated automatically" in the
  // console), so a plain .catch() on created() leaves any busy indicator
  // stuck forever. createCompleted is the only reliable failure signal;
  // messageChange carries the server's actual error text.
  return {
    // oListBinding/oContext: what create() was called on and returned.
    // oBusyControl: anything with setBusy(), cleared as soon as failure is known (optional).
    guard: function (oListBinding, oContext, oBusyControl) {
      var oModel = oListBinding.getModel();
      var sMessage;
      var fnMessage = function (oEvent) {
        var aNew = oEvent.getParameter("newMessages") || [];
        if (aNew.length) { sMessage = aNew[aNew.length - 1].getMessage(); }
      };
      oModel.attachMessageChange(fnMessage);

      oListBinding.attachEventOnce("createCompleted", function (oEvent) {
        oModel.detachMessageChange(fnMessage);
        if (oEvent.getParameter("success")) { return; }
        if (oBusyControl) { oBusyControl.setBusy(false); }
        oContext.delete().catch(function () {}); // drop the stuck pending row
        MessageBox.error(sMessage || "Could not save. Please try again.");
      });
    }
  };
});
