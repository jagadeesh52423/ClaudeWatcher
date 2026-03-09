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
    alert.alertStyle = $.NSAlertStyleInformational;

    var viewWidth = 460;
    var padding = 10;
    var innerW = viewWidth - padding * 2;
    var textFieldHeight = 28;
    var textLabelHeight = 16;
    var popupHeight = 28;
    var gap = 8;

    // Measure question text height (wrapping)
    var questionHeight = measureTextHeight(message, innerW, 13);

    var viewHeight = questionHeight + gap + popupHeight + gap + textLabelHeight + 2 + textFieldHeight + padding * 2;

    var container = $.NSView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, viewWidth, viewHeight)
    );

    // Bottom-up layout (Cocoa is bottom-left origin)
    var y = padding;

    // Text field at the very bottom
    var textField = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, y, innerW, textFieldHeight)
    );
    textField.placeholderString = $("Or type something...");
    textField.font = $.NSFont.systemFontOfSize(13);
    container.addSubview(textField);
    y += textFieldHeight + 2;

    // Label for text field
    var textLabel = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, y, innerW, textLabelHeight)
    );
    textLabel.stringValue = $("Or type something:");
    textLabel.editable = false;
    textLabel.bordered = false;
    textLabel.drawsBackground = false;
    textLabel.font = $.NSFont.systemFontOfSize(11);
    textLabel.textColor = $.NSColor.secondaryLabelColor;
    container.addSubview(textLabel);
    y += textLabelHeight + gap;

    // Dropdown
    var popup = $.NSPopUpButton.alloc.initWithFramePullsDown(
        $.NSMakeRect(padding, y, innerW, popupHeight), false
    );
    popup.font = $.NSFont.systemFontOfSize(13);
    for (var j = 0; j < options.length; j++) {
        popup.addItemWithTitle($((j + 1) + ". " + options[j]));
    }
    container.addSubview(popup);
    y += popupHeight + gap;

    // Question text as wrapping label (not informativeText which truncates)
    var questionLabel = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, y, innerW, questionHeight)
    );
    questionLabel.stringValue = $(message);
    questionLabel.editable = false;
    questionLabel.bordered = false;
    questionLabel.drawsBackground = false;
    questionLabel.font = $.NSFont.systemFontOfSize(13);
    questionLabel.selectable = true;
    questionLabel.lineBreakMode = $.NSLineBreakByWordWrapping;
    questionLabel.usesSingleLineMode = false;
    questionLabel.cell.wraps = true;
    container.addSubview(questionLabel);

    // Tab order: dropdown → text field → dropdown
    popup.nextKeyView = textField;
    textField.nextKeyView = popup;

    alert.accessoryView = container;
    alert.addButtonWithTitle($("Select"));
    alert.addButtonWithTitle($("Skip"));

    setMinWidth(alert, viewWidth + 60);
    alert.window.center;
    alert.window.setLevel($.NSStatusWindowLevel);

    // Focus the dropdown by default
    alert.window.makeFirstResponder(popup);

    var response = alert.runModal;
    if (response == 1000) {
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
    alert.alertStyle = $.NSAlertStyleInformational;

    var viewWidth = 460;
    var padding = 10;
    var innerW = viewWidth - padding * 2;
    var checkboxHeight = 24;
    var textFieldHeight = 28;
    var textLabelHeight = 16;
    var gap = 8;

    var questionHeight = measureTextHeight(message, innerW, 13);

    var viewHeight = questionHeight + gap
        + (options.length * checkboxHeight) + gap
        + textLabelHeight + 2 + textFieldHeight + padding * 2;

    var container = $.NSView.alloc.initWithFrame(
        $.NSMakeRect(0, 0, viewWidth, viewHeight)
    );

    // Bottom-up layout
    var y = padding;

    // Text field at the bottom
    var textField = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, y, innerW, textFieldHeight)
    );
    textField.placeholderString = $("Or type something...");
    textField.font = $.NSFont.systemFontOfSize(13);
    container.addSubview(textField);
    y += textFieldHeight + 2;

    // Label
    var textLabel = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, y, innerW, textLabelHeight)
    );
    textLabel.stringValue = $("Or type something:");
    textLabel.editable = false;
    textLabel.bordered = false;
    textLabel.drawsBackground = false;
    textLabel.font = $.NSFont.systemFontOfSize(11);
    textLabel.textColor = $.NSColor.secondaryLabelColor;
    container.addSubview(textLabel);
    y += textLabelHeight + gap;

    // Checkboxes (last option at bottom, first at top)
    var checkboxes = [];
    for (var i = options.length - 1; i >= 0; i--) {
        var cb = $.NSButton.alloc.initWithFrame(
            $.NSMakeRect(padding, y, innerW, checkboxHeight)
        );
        cb.setButtonType($.NSSwitchButton);
        cb.title = $((i + 1) + ".  " + options[i]);
        cb.font = $.NSFont.systemFontOfSize(13);
        cb.state = $.NSOffState;
        container.addSubview(cb);
        checkboxes.unshift(cb); // keep index order
        y += checkboxHeight;
    }
    y += gap;

    // Question text
    var questionLabel = $.NSTextField.alloc.initWithFrame(
        $.NSMakeRect(padding, y, innerW, questionHeight)
    );
    questionLabel.stringValue = $(message);
    questionLabel.editable = false;
    questionLabel.bordered = false;
    questionLabel.drawsBackground = false;
    questionLabel.font = $.NSFont.systemFontOfSize(13);
    questionLabel.selectable = true;
    questionLabel.lineBreakMode = $.NSLineBreakByWordWrapping;
    questionLabel.usesSingleLineMode = false;
    questionLabel.cell.wraps = true;
    container.addSubview(questionLabel);

    // Tab order: checkbox1 → checkbox2 → ... → textField → checkbox1
    for (var t = 0; t < checkboxes.length - 1; t++) {
        checkboxes[t].nextKeyView = checkboxes[t + 1];
    }
    checkboxes[checkboxes.length - 1].nextKeyView = textField;
    textField.nextKeyView = checkboxes[0];

    alert.accessoryView = container;
    alert.addButtonWithTitle($("Select"));
    alert.addButtonWithTitle($("Skip"));

    setMinWidth(alert, viewWidth + 60);
    alert.window.center;
    alert.window.setLevel($.NSStatusWindowLevel);

    // Focus first checkbox
    alert.window.makeFirstResponder(checkboxes[0]);

    var response = alert.runModal;
    if (response == 1000) {
        var selected = [];
        for (var k = 0; k < checkboxes.length; k++) {
            if (checkboxes[k].state == $.NSOnState) {
                selected.push(k + 1);
            }
        }
        var typedText = textField.stringValue.js;
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

function measureTextHeight(text, width, fontSize) {
    // Use a temporary NSTextField to measure wrapped text height
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
