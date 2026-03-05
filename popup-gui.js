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

function run(argv) {
    var paramsFile = argv[0];
    if (!paramsFile) {
        return "ERROR:no-params-file";
    }

    var data;
    try {
        var content = $.NSString.stringWithContentsOfFileEncodingError(
            $(paramsFile), $.NSUTF8StringEncoding, null
        );
        data = JSON.parse(content.js);
    } catch (e) {
        return "ERROR:parse-failed";
    }

    // Activate as accessory app (no dock icon)
    var app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
    app.activateIgnoringOtherApps(true);

    var type = data.type || "permission";

    if (type === "permission") {
        return showPermission(data);
    } else if (type === "options") {
        return showOptions(data);
    } else if (type === "text") {
        return showText(data);
    }

    return "ERROR:unknown-type";
}

// ─── Permission Dialog ───────────────────────────────────────────────────────
// Large NSAlert with tool name, formatted summary, 3 action buttons

function showPermission(data) {
    var tool = data.tool || "Unknown Tool";
    var summary = data.summary || "";
    var project = data.project || "";

    var title = "Claude Code" + (project ? " — " + project : "");
    var body = "🔧  " + tool;
    if (summary) {
        // Truncate long summaries
        if (summary.length > 500) summary = summary.substring(0, 497) + "...";
        body += "\n\n" + summary;
    }

    var alert = $.NSAlert.alloc.init;
    alert.messageText = $(title);
    alert.informativeText = $(body);
    alert.alertStyle = $.NSAlertStyleWarning;

    // Buttons — rightmost is default
    alert.addButtonWithTitle($("Allow Once"));
    alert.addButtonWithTitle($("Always Allow"));
    alert.addButtonWithTitle($("Deny"));

    // Make the informative text use a slightly larger font
    var views = alert.window.contentView.subviews;
    setMinWidth(alert, 480);

    alert.window.center;
    alert.window.setLevel($.NSStatusWindowLevel);

    var response = alert.runModal;
    // NSAlertFirstButtonReturn = 1000 (returned as string in JXA)
    if (response == 1000) return "Allow Once";
    if (response == 1001) return "Always Allow";
    return "Deny";
}

// ─── Options Dialog ──────────────────────────────────────────────────────────
// NSAlert with radio buttons for each option + "Type something" at bottom

function showOptions(data) {
    var title = data.title || "Claude Code";
    var message = data.message || "Choose an option:";
    var options = data.options || [];
    if (options.length === 0) return "SKIP";

    // Add "Type something" option
    var allOptions = options.concat(["Type something"]);

    var alert = $.NSAlert.alloc.init;
    alert.messageText = $(title);
    alert.informativeText = $(message);
    alert.alertStyle = $.NSAlertStyleInformational;

    // Build radio buttons in a container view
    var rowHeight = 30;
    var padding = 12;
    var viewWidth = 400;
    var viewHeight = allOptions.length * rowHeight + padding;

    var container = $.NSView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, viewWidth, viewHeight)
    );

    var radioGroup = [];
    for (var i = 0; i < allOptions.length; i++) {
        var y = viewHeight - ((i + 1) * rowHeight);
        var radio = $.NSButton.alloc.initWithFrame(
            $.NSMakeRect(8, y, viewWidth - 16, 24)
        );
        radio.setButtonType($.NSButtonTypeRadio);

        var label = (i + 1) + ".  " + allOptions[i];
        radio.title = $(label);
        radio.tag = i;

        // Use slightly larger font
        radio.font = $.NSFont.systemFontOfSize(13);

        // First option selected by default
        radio.state = (i === 0)
            ? $.NSControlStateValueOn
            : $.NSControlStateValueOff;

        container.addSubview(radio);
        radioGroup.push(radio);
    }

    alert.accessoryView = container;
    alert.addButtonWithTitle($("Select"));
    alert.addButtonWithTitle($("Skip"));

    setMinWidth(alert, 480);
    alert.window.center;
    alert.window.setLevel($.NSStatusWindowLevel);

    var response = alert.runModal;
    if (response == 1000) {
        // Find selected radio
        for (var j = 0; j < radioGroup.length; j++) {
            if (radioGroup[j].state == $.NSControlStateValueOn) {
                var idx = radioGroup[j].tag;
                return (idx + 1) + ". " + allOptions[idx];
            }
        }
        // Fallback
        return "1. " + allOptions[0];
    }
    return "SKIP";
}

// ─── Text Input Dialog ───────────────────────────────────────────────────────

function showText(data) {
    var title = data.title || "Claude Code — Question";
    var message = data.message || "Enter your response:";

    var alert = $.NSAlert.alloc.init;
    alert.messageText = $(title);
    alert.informativeText = $(message);
    alert.alertStyle = $.NSAlertStyleInformational;

    // Text field accessory
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

    // Focus the text field
    alert.window.makeFirstResponder(textField);

    var response = alert.runModal;
    if (response == 1000) {
        var text = textField.stringValue.js;
        return text || "__SKIP__";
    }
    return "__SKIP__";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
