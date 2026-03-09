#!/usr/bin/osascript -l JavaScript
//
// popup-gui.js — Native macOS popup dialogs for Claude Code hooks
//
// Usage: osascript -l JavaScript popup-gui.js /path/to/params.json
//
// params.json:
//   { "type": "permission", "tool": "Bash", "summary": "ls -la /tmp", "project": "myapp" }
//   { "type": "options", "title": "Claude Code", "message": "Pick one:", "options": ["a","b","c"] }
//   { "type": "text", "title": "Claude Code", "message": "Enter your response:" }
//

ObjC.import("Cocoa");
ObjC.import("stdlib");

// ─── ObjC subclasses ─────────────────────────────────────────────────────────

ObjC.registerSubclass({
    name: "PanelButtonHandler",
    methods: {
        "buttonClicked:": {
            types: ["void", ["id"]],
            implementation: function (sender) {
                $.NSApp.stopModalWithCode(sender.tag);
            }
        }
    }
});

var _buttonHandler = $.PanelButtonHandler.alloc.init;

// Custom NSPanel that intercepts Tab/Shift-Tab to cycle ALL controls
// (macOS normally skips non-text controls unless system keyboard nav is on)
// Key insight: when a text field is focused, the actual firstResponder is an
// NSTextView (field editor), not the NSTextField itself. We must resolve it
// back to the delegate control before following the nextKeyView chain.
ObjC.registerSubclass({
    name: "TabPanel",
    superclass: "NSPanel",
    methods: {
        "sendEvent:": {
            types: ["void", ["id"]],
            implementation: function (event) {
                // NSEventTypeKeyDown = 10, Tab keyCode = 48
                if (event.type == 10 && event.keyCode == 48) {
                    var fr = this.firstResponder;
                    var control = fr;

                    // Resolve field editor back to actual control
                    if (fr.isKindOfClass($.NSTextView)) {
                        var delegate = fr.delegate;
                        if (delegate && delegate.isKindOfClass($.NSControl)) {
                            control = delegate;
                        }
                    }

                    var shift = (event.modifierFlags & $.NSEventModifierFlagShift) != 0;
                    var next = shift ? control.previousKeyView : control.nextKeyView;
                    if (next) {
                        this.makeFirstResponder(next);
                    }
                    return; // consume Tab
                }
                ObjC.super(this).sendEvent(event);
            }
        }
    }
});

// Result codes
var RC_OK = 1;
var RC_SKIP = 2;

// ─── Entry point ─────────────────────────────────────────────────────────────

function run(argv) {
    var paramsFile = argv[0];
    if (!paramsFile) return "ERROR:no-params-file";

    var data;
    try {
        var content = $.NSString.stringWithContentsOfFileEncodingError(
            $(paramsFile), $.NSUTF8StringEncoding, null
        );
        data = JSON.parse(content.js);
    } catch (e) {
        return "ERROR:parse-failed";
    }

    var app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
    app.activateIgnoringOtherApps(true);

    var type = data.type || "permission";

    if (type === "permission") return showPermission(data);
    if (type === "options")    return showOptions(data);
    if (type === "text")       return showText(data);

    return "ERROR:unknown-type";
}

// ─── Permission Dialog (NSAlert — simple, no tab issues) ─────────────────────

function showPermission(data) {
    var tool = data.tool || "Unknown Tool";
    var summary = data.summary || "";
    var project = data.project || "";

    var title = "Claude Code" + (project ? " — " + project : "");
    var body = "🔧  " + tool;
    if (summary) {
        if (summary.length > 500) summary = summary.substring(0, 497) + "...";
        body += "\n\n" + summary;
    }

    var alert = $.NSAlert.alloc.init;
    alert.messageText = $(title);
    alert.informativeText = $(body);
    alert.alertStyle = $.NSAlertStyleWarning;

    alert.addButtonWithTitle($("Allow Once"));
    alert.addButtonWithTitle($("Always Allow"));
    alert.addButtonWithTitle($("Deny"));

    setMinWidth(alert, 480);
    alert.window.center;
    alert.window.setLevel($.NSStatusWindowLevel);

    var response = alert.runModal;
    if (response == 1000) return "Allow Once";
    if (response == 1001) return "Always Allow";
    return "Deny";
}

// ─── Options Dialog (NSPanel — full Tab support) ─────────────────────────────

function showOptions(data) {
    var title = data.title || "Claude Code";
    var message = data.message || "Choose an option:";
    var options = data.options || [];
    if (options.length === 0) return "SKIP";

    if (data.multiSelect) return showMultiSelect(data);

    var W = 500, pad = 16, innerW = W - pad * 2;
    var btnH = 32, tfH = 28, lblH = 16, popH = 28, gap = 10;

    var qH = measureTextHeight(message, innerW, 13);

    var totalH = pad + qH + gap + popH + gap + lblH + 4 + tfH + gap + btnH + pad;

    var panel = makePanel(title, W, totalH);
    var cv = panel.contentView;
    var y = pad;

    // --- Buttons at bottom ---
    var skipBtn = makeButton("Skip", pad, y, 90, btnH, RC_SKIP);
    var selBtn  = makeButton("Select", W - pad - 100, y, 100, btnH, RC_OK);
    selBtn.keyEquivalent = $("\r"); // Enter = Select
    cv.addSubview(skipBtn);
    cv.addSubview(selBtn);
    y += btnH + gap;

    // --- Text field ---
    var textField = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(pad, y, innerW, tfH)
    );
    textField.placeholderString = $("Or type something...");
    textField.font = $.NSFont.systemFontOfSize(13);
    cv.addSubview(textField);
    y += tfH + 4;

    // --- "Or type something:" label ---
    var lbl = makeLabel("Or type something:", pad, y, innerW, lblH, 11);
    lbl.textColor = $.NSColor.secondaryLabelColor;
    cv.addSubview(lbl);
    y += lblH + gap;

    // --- Dropdown ---
    var popup = $.NSPopUpButton.alloc.initWithFramePullsDown(
        $.NSMakeRect(pad, y, innerW, popH), false
    );
    popup.font = $.NSFont.systemFontOfSize(13);
    for (var j = 0; j < options.length; j++) {
        popup.addItemWithTitle($((j + 1) + ". " + options[j]));
    }
    cv.addSubview(popup);
    y += popH + gap;

    // --- Question label ---
    var qLabel = makeLabel(message, pad, y, innerW, qH, 13);
    qLabel.selectable = true;
    cv.addSubview(qLabel);

    // --- Tab order: popup → textField → Select → Skip → popup ---
    popup.nextKeyView = textField;
    textField.nextKeyView = selBtn;
    selBtn.nextKeyView = skipBtn;
    skipBtn.nextKeyView = popup;
    // Reverse for Shift-Tab
    popup.previousKeyView = skipBtn;
    skipBtn.previousKeyView = selBtn;
    selBtn.previousKeyView = textField;
    textField.previousKeyView = popup;
    panel.initialFirstResponder = popup;

    var rc = runPanel(panel);
    if (rc == RC_OK) {
        var typed = textField.stringValue.js;
        if (typed && typed.length > 0) return "OTHER:" + typed;
        var idx = parseInt("" + popup.indexOfSelectedItem, 10);
        return (idx + 1) + ". " + options[idx];
    }
    return "SKIP";
}

// ─── Multi-Select Dialog (NSPanel) ───────────────────────────────────────────

function showMultiSelect(data) {
    var title = data.title || "Claude Code";
    var message = data.message || "Select one or more options:";
    var options = data.options || [];

    var W = 500, pad = 16, innerW = W - pad * 2;
    var btnH = 32, tfH = 28, lblH = 16, cbH = 24, gap = 10;

    var qH = measureTextHeight(message, innerW, 13);

    var totalH = pad + qH + gap + (options.length * cbH) + gap + lblH + 4 + tfH + gap + btnH + pad;

    var panel = makePanel(title, W, totalH);
    var cv = panel.contentView;
    var y = pad;

    // --- Buttons at bottom ---
    var skipBtn = makeButton("Skip", pad, y, 90, btnH, RC_SKIP);
    var selBtn  = makeButton("Select", W - pad - 100, y, 100, btnH, RC_OK);
    selBtn.keyEquivalent = $("\r");
    cv.addSubview(skipBtn);
    cv.addSubview(selBtn);
    y += btnH + gap;

    // --- Text field ---
    var textField = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(pad, y, innerW, tfH)
    );
    textField.placeholderString = $("Or type something...");
    textField.font = $.NSFont.systemFontOfSize(13);
    cv.addSubview(textField);
    y += tfH + 4;

    // --- Label ---
    var lbl = makeLabel("Or type something:", pad, y, innerW, lblH, 11);
    lbl.textColor = $.NSColor.secondaryLabelColor;
    cv.addSubview(lbl);
    y += lblH + gap;

    // --- Checkboxes (last at bottom, first at top) ---
    var checkboxes = [];
    for (var i = options.length - 1; i >= 0; i--) {
        var cb = $.NSButton.alloc.initWithFrame(
            $.NSMakeRect(pad, y, innerW, cbH)
        );
        cb.setButtonType($.NSSwitchButton);
        cb.title = $((i + 1) + ".  " + options[i]);
        cb.font = $.NSFont.systemFontOfSize(13);
        cb.state = $.NSOffState;
        cv.addSubview(cb);
        checkboxes.unshift(cb);
        y += cbH;
    }
    y += gap;

    // --- Question label ---
    var qLabel = makeLabel(message, pad, y, innerW, qH, 13);
    qLabel.selectable = true;
    cv.addSubview(qLabel);

    // --- Tab order: cb1 → cb2 → ... → textField → Select → Skip → cb1 ---
    for (var t = 0; t < checkboxes.length - 1; t++) {
        checkboxes[t].nextKeyView = checkboxes[t + 1];
        checkboxes[t + 1].previousKeyView = checkboxes[t];
    }
    checkboxes[checkboxes.length - 1].nextKeyView = textField;
    textField.previousKeyView = checkboxes[checkboxes.length - 1];
    textField.nextKeyView = selBtn;
    selBtn.previousKeyView = textField;
    selBtn.nextKeyView = skipBtn;
    skipBtn.previousKeyView = selBtn;
    skipBtn.nextKeyView = checkboxes[0];
    checkboxes[0].previousKeyView = skipBtn;
    panel.initialFirstResponder = checkboxes[0];

    var rc = runPanel(panel);
    if (rc == RC_OK) {
        var selected = [];
        for (var k = 0; k < checkboxes.length; k++) {
            if (checkboxes[k].state == $.NSOnState) selected.push(k + 1);
        }
        var typed = textField.stringValue.js;
        if (typed && typed.length > 0) selected.push("OTHER:" + typed);
        if (selected.length === 0) return "SKIP";
        return selected.join("|");
    }
    return "SKIP";
}

// ─── Text Input Dialog (NSAlert — just a text field, Tab not needed) ─────────

function showText(data) {
    var title = data.title || "Claude Code — Question";
    var message = data.message || "Enter your response:";

    var alert = $.NSAlert.alloc.init;
    alert.messageText = $(title);
    alert.informativeText = $(message);
    alert.alertStyle = $.NSAlertStyleInformational;

    var textField = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(0, 0, 380, 80)
    );
    textField.placeholderString = $("Type your response here...");
    textField.font = $.NSFont.systemFontOfSize(13);

    alert.accessoryView = textField;
    alert.addButtonWithTitle($("Send"));
    alert.addButtonWithTitle($("Skip"));

    setMinWidth(alert, 460);
    alert.window.center;
    alert.window.setLevel($.NSStatusWindowLevel);
    alert.window.makeFirstResponder(textField);

    var response = alert.runModal;
    if (response == 1000) {
        var text = textField.stringValue.js;
        return text || "__SKIP__";
    }
    return "__SKIP__";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePanel(title, width, height) {
    var panel = $.TabPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(0, 0, width, height),
        $.NSTitledWindowMask | $.NSClosableWindowMask,
        $.NSBackingStoreBuffered,
        false
    );
    panel.title = $(title);
    panel.setLevel($.NSStatusWindowLevel);
    panel.center;
    panel.autorecalculatesKeyViewLoop = false;
    return panel;
}

function makeButton(label, x, y, w, h, tag) {
    var btn = $.NSButton.alloc.initWithFrame($.NSMakeRect(x, y, w, h));
    btn.title = $(label);
    btn.bezelStyle = $.NSBezelStyleRounded;
    btn.font = $.NSFont.systemFontOfSize(13);
    btn.tag = tag;
    btn.target = _buttonHandler;
    btn.action = "buttonClicked:";
    return btn;
}

function makeLabel(text, x, y, w, h, fontSize) {
    var lbl = $.NSTextField.alloc.initWithFrame($.NSMakeRect(x, y, w, h));
    lbl.stringValue = $(text);
    lbl.editable = false;
    lbl.bordered = false;
    lbl.drawsBackground = false;
    lbl.font = $.NSFont.systemFontOfSize(fontSize);
    lbl.lineBreakMode = $.NSLineBreakByWordWrapping;
    lbl.usesSingleLineMode = false;
    lbl.cell.wraps = true;
    return lbl;
}

function runPanel(panel) {
    panel.makeKeyAndOrderFront(null);
    $.NSApp.activateIgnoringOtherApps(true);
    var rc = $.NSApp.runModalForWindow(panel);
    panel.orderOut(null);
    return rc;
}

function measureTextHeight(text, width, fontSize) {
    var tf = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, width, 10));
    tf.stringValue = $(text);
    tf.font = $.NSFont.systemFontOfSize(fontSize);
    tf.editable = false;
    tf.bordered = false;
    tf.lineBreakMode = $.NSLineBreakByWordWrapping;
    tf.usesSingleLineMode = false;
    tf.cell.wraps = true;
    tf.preferredMaxLayoutWidth = width;
    var size = tf.cell.cellSizeForBounds($.NSMakeRect(0, 0, width, 10000));
    return Math.ceil(size.height) + 4;
}

function setMinWidth(alert, width) {
    var win = alert.window;
    var frame = win.frame;
    if (frame.size.width < width) {
        win.setFrameDisplay(
            $.NSMakeRect(frame.origin.x, frame.origin.y, width, frame.size.height),
            true
        );
    }
}
