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
// NSAlert with NSPopUpButton dropdown for single selection

function showOptions(data) {
    var title = data.title || "Claude Code";
    var message = data.message || "Choose an option:";
    var options = data.options || [];
    if (options.length === 0) return "SKIP";

    if (data.multiSelect) {
        return showMultiSelect(data);
    }

    var alert = $.NSAlert.alloc.init;
    alert.messageText = $(title);
    alert.informativeText = $(message);
    alert.alertStyle = $.NSAlertStyleInformational;

    // Container: numbered list + dropdown + "or type something" text field
    var viewWidth = 420;
    var padding = 8;
    var textFieldHeight = 28;
    var textLabelHeight = 18;
    var popupHeight = 30;
    var listHeight = options.length * 22 + 8;
    var viewHeight = listHeight + popupHeight + 12 + textLabelHeight + textFieldHeight + padding * 2;

    var container = $.NSView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, viewWidth, viewHeight)
    );

    // Text field at the very bottom
    var textField = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, padding, viewWidth - padding * 2, textFieldHeight)
    );
    textField.placeholderString = $("Type something else...");
    textField.font = $.NSFont.systemFontOfSize(13);
    container.addSubview(textField);

    // Label for text field
    var textLabel = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, padding + textFieldHeight + 2, viewWidth - padding * 2, textLabelHeight)
    );
    textLabel.stringValue = $("Or type something:");
    textLabel.editable = false;
    textLabel.bordered = false;
    textLabel.drawsBackground = false;
    textLabel.font = $.NSFont.systemFontOfSize(11);
    textLabel.textColor = $.NSColor.secondaryLabelColor;
    container.addSubview(textLabel);

    // Dropdown popup button above the text area
    var popupY = padding + textFieldHeight + textLabelHeight + padding;
    var popup = $.NSPopUpButton.alloc.initWithFramePullsDown(
        $.NSMakeRect(padding, popupY, viewWidth - padding * 2, 28), false
    );
    popup.font = $.NSFont.systemFontOfSize(13);
    for (var j = 0; j < options.length; j++) {
        popup.addItemWithTitle($((j + 1) + ". " + options[j]));
    }
    container.addSubview(popup);

    // Numbered list as static text (for visual reference)
    var listText = "";
    for (var i = 0; i < options.length; i++) {
        listText += (i + 1) + ".  " + options[i] + "\n";
    }
    var label = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, popupY + popupHeight + 4, viewWidth - padding * 2, listHeight)
    );
    label.stringValue = $(listText.trim());
    label.editable = false;
    label.bordered = false;
    label.drawsBackground = false;
    label.font = $.NSFont.systemFontOfSize(13);
    label.selectable = false;
    container.addSubview(label);

    alert.accessoryView = container;
    alert.addButtonWithTitle($("Select"));
    alert.addButtonWithTitle($("Skip"));

    setMinWidth(alert, 500);
    alert.window.center;
    alert.window.setLevel($.NSStatusWindowLevel);

    var response = alert.runModal;
    if (response == 1000) {
        // Text field takes priority — if user typed something, return that
        var typedText = textField.stringValue.js;
        if (typedText && typedText.length > 0) {
            return "OTHER:" + typedText;
        }
        var selectedIdx = popup.indexOfSelectedItem;
        var idx = parseInt("" + selectedIdx, 10);
        return (idx + 1) + ". " + options[idx];
    }
    return "SKIP";
}

// ─── Multi-Select Dialog ────────────────────────────────────────────────────
// NSAlert with checkboxes for multiple selection + "Type something" text field

function showMultiSelect(data) {
    var title = data.title || "Claude Code";
    var message = data.message || "Select one or more options:";
    var options = data.options || [];

    var alert = $.NSAlert.alloc.init;
    alert.messageText = $(title);
    alert.informativeText = $(message);
    alert.alertStyle = $.NSAlertStyleInformational;

    var viewWidth = 420;
    var checkboxHeight = 24;
    var textFieldHeight = 28;
    var textLabelHeight = 18;
    var padding = 8;
    // checkboxes + "Type something" label + text field
    var viewHeight = (options.length * checkboxHeight) + padding + textLabelHeight + textFieldHeight + padding * 2;

    var container = $.NSView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, viewWidth, viewHeight)
    );

    // "Type something" text field at the bottom
    var textField = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, padding, viewWidth - padding * 2, textFieldHeight)
    );
    textField.placeholderString = $("Type something else...");
    textField.font = $.NSFont.systemFontOfSize(13);
    container.addSubview(textField);

    // Label for text field
    var textLabel = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, padding + textFieldHeight + 2, viewWidth - padding * 2, textLabelHeight)
    );
    textLabel.stringValue = $("Or type something:");
    textLabel.editable = false;
    textLabel.bordered = false;
    textLabel.drawsBackground = false;
    textLabel.font = $.NSFont.systemFontOfSize(11);
    textLabel.textColor = $.NSColor.secondaryLabelColor;
    container.addSubview(textLabel);

    // Checkboxes (bottom-up layout, above the text field)
    var checkboxes = [];
    var baseY = padding + textFieldHeight + textLabelHeight + padding;
    for (var i = 0; i < options.length; i++) {
        var cb = $.NSButton.alloc.initWithFrame(
            $.NSMakeRect(padding, baseY + (options.length - 1 - i) * checkboxHeight, viewWidth - padding * 2, checkboxHeight)
        );
        cb.setButtonType($.NSSwitchButton);
        cb.title = $((i + 1) + ".  " + options[i]);
        cb.font = $.NSFont.systemFontOfSize(13);
        cb.state = $.NSOffState;
        container.addSubview(cb);
        checkboxes.push(cb);
    }

    alert.accessoryView = container;
    alert.addButtonWithTitle($("Select"));
    alert.addButtonWithTitle($("Skip"));

    setMinWidth(alert, 500);
    alert.window.center;
    alert.window.setLevel($.NSStatusWindowLevel);

    var response = alert.runModal;
    if (response == 1000) {
        var selected = [];
        for (var k = 0; k < checkboxes.length; k++) {
            if (checkboxes[k].state == $.NSOnState) {
                selected.push(k + 1);
            }
        }
        var typedText = textField.stringValue.js;

        // If user typed something, add it
        if (typedText && typedText.length > 0) {
            selected.push("OTHER:" + typedText);
        }

        if (selected.length === 0) return "SKIP";
        return selected.join("|");
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
