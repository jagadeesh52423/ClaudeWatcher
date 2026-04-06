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

// ─── Theme Colors ────────────────────────────────────────────────────────────

var THEME = {
    // Panel background — light warm gray
    panelBg:     [0.94, 0.94, 0.95, 1.0],
    // Header bar — warm medium gray with subtle warmth
    headerBg:    [0.36, 0.34, 0.38, 1.0],
    headerText:  [1.0, 1.0, 1.0, 1.0],
    // Section background — light card
    sectionBg:   [0.88, 0.88, 0.90, 1.0],
    // Text colors
    primaryText: [0.15, 0.15, 0.18, 1.0],
    secondaryText: [0.45, 0.45, 0.50, 1.0],
    accentText:  [0.25, 0.48, 0.72, 1.0],
    // Button colors — soft pastels
    allowBtn:    [0.42, 0.75, 0.55, 1.0],   // soft mint green
    allowBtnText:[1.0, 1.0, 1.0, 1.0],
    alwaysBtn:   [0.50, 0.65, 0.85, 1.0],   // soft periwinkle
    alwaysBtnText:[1.0, 1.0, 1.0, 1.0],
    denyBtn:     [0.82, 0.50, 0.50, 1.0],   // soft coral
    denyBtnText: [1.0, 1.0, 1.0, 1.0],
    selectBtn:   [0.50, 0.65, 0.85, 1.0],   // soft periwinkle
    selectBtnText:[1.0, 1.0, 1.0, 1.0],
    skipBtn:     [0.72, 0.72, 0.75, 1.0],   // light gray
    skipBtnText: [0.30, 0.30, 0.35, 1.0],
    // Input fields
    inputBg:     [1.0, 1.0, 1.0, 1.0],
    inputText:   [0.15, 0.15, 0.18, 1.0],
    inputBorder: [0.78, 0.78, 0.82, 1.0],
    // Checkbox / option text
    optionText:  [0.20, 0.20, 0.25, 1.0],
    // Separator
    separator:   [0.82, 0.82, 0.85, 1.0],
    // Tool name highlight — warm teal
    toolHighlight: [0.18, 0.55, 0.58, 1.0],
};

function nsColor(rgba) {
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(rgba[0], rgba[1], rgba[2], rgba[3]);
}

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

// NOTE: Previously used a custom TabPanel NSPanel subclass to intercept Tab/Shift-Tab,
// but ObjC.super(this).sendEvent(event) causes infinite recursion on macOS 26+.
// Using plain NSPanel instead — manual key view loop still works via nextKeyView/previousKeyView.

// Result codes
var RC_OK = 1;
var RC_SKIP = 2;
var RC_DENY = 3;
var RC_ALWAYS = 4;

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

// ─── Permission Dialog (fully themed NSPanel) ────────────────────────────────

function showPermission(data) {
    var tool = data.tool || "Unknown Tool";
    var summary = data.summary || "";
    var project = data.project || "";

    if (summary.length > 800) summary = summary.substring(0, 797) + "...";

    var W = 520, pad = 20, innerW = W - pad * 2;
    var headerH = 52, btnH = 36, gap = 12;

    // Measure summary height
    var summaryH = summary ? measureTextHeight(summary, innerW - 20, 12) + 16 : 0;
    var toolLblH = 28;

    var totalH = headerH + gap + toolLblH + (summaryH > 0 ? gap + summaryH : 0) + gap + btnH + pad;

    var panel = makeThemedPanel("Claude Code", W, totalH);
    var cv = panel.contentView;
    cv.wantsLayer = true;
    var y = 0;

    // --- Buttons at bottom ---
    var denyBtn = makeThemedButton("Deny", pad, pad, 100, btnH, RC_DENY, THEME.denyBtn, THEME.denyBtnText);
    var alwaysBtn = makeThemedButton("Always Allow", W / 2 - 65, pad, 130, btnH, RC_ALWAYS, THEME.alwaysBtn, THEME.alwaysBtnText);
    var allowBtn = makeThemedButton("Allow Once", W - pad - 110, pad, 110, btnH, RC_OK, THEME.allowBtn, THEME.allowBtnText);
    allowBtn.keyEquivalent = $("\r");
    cv.addSubview(denyBtn);
    cv.addSubview(alwaysBtn);
    cv.addSubview(allowBtn);
    y = pad + btnH + gap;

    // --- Summary section ---
    if (summary) {
        var summaryBox = $.NSBox.alloc.initWithFrame($.NSMakeRect(pad, y, innerW, summaryH));
        summaryBox.boxType = $.NSBoxCustom;
        summaryBox.fillColor = nsColor(THEME.sectionBg);
        summaryBox.cornerRadius = 8;
        summaryBox.borderWidth = 0;
        summaryBox.contentViewMargins = $.NSMakeSize(10, 8);
        var sLbl = makeThemedLabel(summary, 0, 0, innerW - 20, summaryH - 16, 12, THEME.secondaryText);
        sLbl.font = $.NSFont.monospacedSystemFontOfSizeWeight(11, 0);
        summaryBox.contentView.addSubview(sLbl);
        cv.addSubview(summaryBox);
        y += summaryH + gap;
    }

    // --- Tool name ---
    var toolLbl = makeThemedLabel("  " + tool, pad, y, innerW, toolLblH, 16, THEME.toolHighlight);
    toolLbl.font = $.NSFont.boldSystemFontOfSize(16);
    cv.addSubview(toolLbl);
    y += toolLblH + gap;

    // --- Header bar ---
    var headerTitle = project ? "Permission Request — " + project : "Permission Request";
    addHeaderBar(cv, headerTitle, W, y, headerH);

    // --- Tab order ---
    allowBtn.nextKeyView = alwaysBtn;
    alwaysBtn.nextKeyView = denyBtn;
    denyBtn.nextKeyView = allowBtn;
    allowBtn.previousKeyView = denyBtn;
    denyBtn.previousKeyView = alwaysBtn;
    alwaysBtn.previousKeyView = allowBtn;
    panel.initialFirstResponder = allowBtn;

    var rc = runPanel(panel);
    if (rc == RC_OK) return "Allow Once";
    if (rc == RC_ALWAYS) return "Always Allow";
    return "Deny";
}

// ─── Options Dialog (themed NSPanel) ─────────────────────────────────────────

function showOptions(data) {
    var title = data.title || "Claude Code";
    var message = data.message || "Choose an option:";
    var options = data.options || [];
    if (options.length === 0) return "SKIP";

    if (data.multiSelect) return showMultiSelect(data);

    var W = 520, pad = 20, innerW = W - pad * 2;
    var headerH = 52, btnH = 36, tfH = 30, lblH = 18, popH = 30, gap = 12;

    var qH = measureTextHeight(message, innerW, 13) + 4;

    var totalH = headerH + gap + qH + gap + popH + gap + lblH + 6 + tfH + gap + btnH + pad;

    var panel = makeThemedPanel(title, W, totalH);
    var cv = panel.contentView;
    cv.wantsLayer = true;
    var y = pad;

    // --- Buttons ---
    var skipBtn = makeThemedButton("Skip", pad, y, 90, btnH, RC_SKIP, THEME.skipBtn, THEME.skipBtnText);
    var selBtn = makeThemedButton("Select", W - pad - 110, y, 110, btnH, RC_OK, THEME.selectBtn, THEME.selectBtnText);
    selBtn.keyEquivalent = $("\r");
    cv.addSubview(skipBtn);
    cv.addSubview(selBtn);
    y += btnH + gap;

    // --- Text field ---
    var textField = makeThemedTextField(pad, y, innerW, tfH);
    textField.placeholderString = $("Or type something...");
    cv.addSubview(textField);
    y += tfH + 6;

    // --- Label ---
    var lbl = makeThemedLabel("Or type something:", pad, y, innerW, lblH, 11, THEME.secondaryText);
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
    var qLabel = makeThemedLabel(message, pad, y, innerW, qH, 13, THEME.primaryText);
    qLabel.selectable = true;
    cv.addSubview(qLabel);
    y += qH + gap;

    // --- Header bar ---
    addHeaderBar(cv, title, W, y, headerH);

    // --- Tab order ---
    popup.nextKeyView = textField;
    textField.nextKeyView = selBtn;
    selBtn.nextKeyView = skipBtn;
    skipBtn.nextKeyView = popup;
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

// ─── Multi-Select Dialog (themed NSPanel) ────────────────────────────────────

function showMultiSelect(data) {
    var title = data.title || "Claude Code";
    var message = data.message || "Select one or more options:";
    var options = data.options || [];

    var W = 520, pad = 20, innerW = W - pad * 2;
    var headerH = 52, btnH = 36, tfH = 30, lblH = 18, cbH = 28, gap = 12;

    var qH = measureTextHeight(message, innerW, 13) + 4;

    var totalH = headerH + gap + qH + gap + (options.length * cbH) + gap + lblH + 6 + tfH + gap + btnH + pad;

    var panel = makeThemedPanel(title, W, totalH);
    var cv = panel.contentView;
    cv.wantsLayer = true;
    var y = pad;

    // --- Buttons ---
    var skipBtn = makeThemedButton("Skip", pad, y, 90, btnH, RC_SKIP, THEME.skipBtn, THEME.skipBtnText);
    var selBtn = makeThemedButton("Select", W - pad - 110, y, 110, btnH, RC_OK, THEME.selectBtn, THEME.selectBtnText);
    selBtn.keyEquivalent = $("\r");
    cv.addSubview(skipBtn);
    cv.addSubview(selBtn);
    y += btnH + gap;

    // --- Text field ---
    var textField = makeThemedTextField(pad, y, innerW, tfH);
    textField.placeholderString = $("Or type something...");
    cv.addSubview(textField);
    y += tfH + 6;

    // --- Label ---
    var lbl = makeThemedLabel("Or type something:", pad, y, innerW, lblH, 11, THEME.secondaryText);
    cv.addSubview(lbl);
    y += lblH + gap;

    // --- Checkboxes (last at bottom, first at top) ---
    var checkboxes = [];
    for (var i = options.length - 1; i >= 0; i--) {
        var cb = $.NSButton.alloc.initWithFrame(
            $.NSMakeRect(pad + 4, y, innerW - 4, cbH)
        );
        cb.setButtonType($.NSSwitchButton);
        cb.title = $((i + 1) + ".  " + options[i]);
        cb.font = $.NSFont.systemFontOfSize(13);
        cb.state = $.NSOffState;
        // Dark appearance handles text color automatically
        cv.addSubview(cb);
        checkboxes.unshift(cb);
        y += cbH;
    }
    y += gap;

    // --- Question label ---
    var qLabel = makeThemedLabel(message, pad, y, innerW, qH, 13, THEME.primaryText);
    qLabel.selectable = true;
    cv.addSubview(qLabel);
    y += qH + gap;

    // --- Header bar ---
    addHeaderBar(cv, title, W, y, headerH);

    // --- Tab order ---
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

// ─── Text Input Dialog (themed NSPanel) ──────────────────────────────────────

function showText(data) {
    var title = data.title || "Claude Code — Question";
    var message = data.message || "Enter your response:";

    var W = 520, pad = 20, innerW = W - pad * 2;
    var headerH = 52, btnH = 36, tfH = 80, gap = 12;

    var qH = measureTextHeight(message, innerW, 13) + 4;

    var totalH = headerH + gap + qH + gap + tfH + gap + btnH + pad;

    var panel = makeThemedPanel(title, W, totalH);
    var cv = panel.contentView;
    cv.wantsLayer = true;
    var y = pad;

    // --- Buttons ---
    var skipBtn = makeThemedButton("Skip", pad, y, 90, btnH, RC_SKIP, THEME.skipBtn, THEME.skipBtnText);
    var sendBtn = makeThemedButton("Send", W - pad - 110, y, 110, btnH, RC_OK, THEME.selectBtn, THEME.selectBtnText);
    sendBtn.keyEquivalent = $("\r");
    cv.addSubview(skipBtn);
    cv.addSubview(sendBtn);
    y += btnH + gap;

    // --- Text field ---
    var textField = makeThemedTextField(pad, y, innerW, tfH);
    textField.placeholderString = $("Type your response here...");
    cv.addSubview(textField);
    y += tfH + gap;

    // --- Question label ---
    var qLabel = makeThemedLabel(message, pad, y, innerW, qH, 13, THEME.primaryText);
    qLabel.selectable = true;
    cv.addSubview(qLabel);
    y += qH + gap;

    // --- Header bar ---
    addHeaderBar(cv, title, W, y, headerH);

    // --- Tab order ---
    textField.nextKeyView = sendBtn;
    sendBtn.nextKeyView = skipBtn;
    skipBtn.nextKeyView = textField;
    textField.previousKeyView = skipBtn;
    skipBtn.previousKeyView = sendBtn;
    sendBtn.previousKeyView = textField;
    panel.initialFirstResponder = textField;

    var rc = runPanel(panel);
    if (rc == RC_OK) {
        var text = textField.stringValue.js;
        return text || "__SKIP__";
    }
    return "__SKIP__";
}

// ─── Themed Helpers ──────────────────────────────────────────────────────────

function makeThemedPanel(title, width, height) {
    var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(0, 0, width, height),
        $.NSTitledWindowMask | $.NSClosableWindowMask,
        $.NSBackingStoreBuffered,
        false
    );
    panel.title = $(title);
    panel.setLevel($.NSStatusWindowLevel);
    panel.center;
    panel.autorecalculatesKeyViewLoop = false;
    panel.backgroundColor = nsColor(THEME.panelBg);
    // Dark title bar
    panel.titlebarAppearsTransparent = true;
    panel.titleVisibility = $.NSWindowTitleHidden;
    panel.appearance = $.NSAppearance.appearanceNamed($.NSAppearanceNameAqua);
    return panel;
}

function addHeaderBar(contentView, titleText, panelW, yPos, headerH) {
    // Background bar
    var bar = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, yPos, panelW, headerH));
    bar.boxType = $.NSBoxCustom;
    bar.fillColor = nsColor(THEME.headerBg);
    bar.borderWidth = 0;
    contentView.addSubview(bar);

    // Title text
    var tLbl = $.NSTextField.alloc.initWithFrame($.NSMakeRect(20, yPos + 12, panelW - 40, 28));
    tLbl.stringValue = $(titleText);
    tLbl.editable = false;
    tLbl.bordered = false;
    tLbl.drawsBackground = false;
    tLbl.textColor = nsColor(THEME.headerText);
    tLbl.font = $.NSFont.boldSystemFontOfSize(17);
    contentView.addSubview(tLbl);

    // Separator line
    var sep = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, yPos - 1, panelW, 1));
    sep.boxType = $.NSBoxCustom;
    sep.fillColor = nsColor(THEME.separator);
    sep.borderWidth = 0;
    contentView.addSubview(sep);
}

function makeThemedButton(label, x, y, w, h, tag, bgColor, textColor) {
    var btn = $.NSButton.alloc.initWithFrame($.NSMakeRect(x, y, w, h));
    btn.bezelStyle = $.NSBezelStyleRounded;
    btn.bordered = true;
    btn.bezelColor = nsColor(bgColor);

    btn.title = $(label);
    btn.font = $.NSFont.boldSystemFontOfSize(13);

    btn.tag = tag;
    btn.target = _buttonHandler;
    btn.action = "buttonClicked:";
    return btn;
}

function makeThemedLabel(text, x, y, w, h, fontSize, colorArr) {
    var lbl = $.NSTextField.alloc.initWithFrame($.NSMakeRect(x, y, w, h));
    lbl.stringValue = $(text);
    lbl.editable = false;
    lbl.bordered = false;
    lbl.drawsBackground = false;
    lbl.textColor = nsColor(colorArr);
    lbl.font = $.NSFont.systemFontOfSize(fontSize);
    lbl.lineBreakMode = $.NSLineBreakByWordWrapping;
    lbl.usesSingleLineMode = false;
    lbl.cell.wraps = true;
    return lbl;
}

function makeThemedTextField(x, y, w, h) {
    var tf = $.NSTextField.alloc.initWithFrame($.NSMakeRect(x, y, w, h));
    tf.font = $.NSFont.systemFontOfSize(13);
    tf.drawsBackground = true;
    tf.backgroundColor = nsColor(THEME.inputBg);
    tf.textColor = nsColor(THEME.inputText);
    tf.bordered = true;
    tf.bezelStyle = $.NSTextFieldRoundedBezel;
    tf.focusRingType = $.NSFocusRingTypeNone;
    return tf;
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
