// termview.ts
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}
var BIN = "termview";
var SHELL = hs.appinfo.environment.SHELL ?? "/bin/zsh";
var pendingTasks = /* @__PURE__ */ new Set();
function runLoginShell(argv) {
  let task;
  task = hs.task.create(
    SHELL,
    ["-l", "-i", "-c", argv],
    () => {
      pendingTasks.delete(task);
    },
    null,
    null
  );
  pendingTasks.add(task);
  task.start();
}
function summon(workspace, cmd, extraArgs) {
  const cmdPart = cmd ? `${shellQuote(cmd)} ` : "";
  const argv = `${BIN} open ${cmdPart}--workspace ${workspace} --persistent${extraArgs ?? ""}`;
  runLoginShell(argv);
}
var pendingPicks = /* @__PURE__ */ new Map();
var pickHandlerBound = false;
function ensurePickHandlerBound() {
  if (pickHandlerBound) return;
  pickHandlerBound = true;
  hs.urlevent.bind("termview-pick", (_eventName, params) => {
    const workspace = params.workspace;
    const callback = workspace ? pendingPicks.get(workspace) : void 0;
    if (!callback || !workspace) return;
    pendingPicks.delete(workspace);
    const result = (params.stdout ?? "").trim();
    if (result === "") return;
    callback(result);
  });
}
function pick(workspace, cmd, cwd, callback) {
  ensurePickHandlerBound();
  pendingPicks.set(workspace, callback);
  const reportUrl = `hammerspoon2://termview-pick?workspace=${workspace}&stdout={stdout}`;
  const argv = `${BIN} open ${shellQuote(cmd)} --workspace ${workspace} --cwd ${shellQuote(cwd)} --report ${shellQuote(reportUrl)}`;
  runLoginShell(argv);
}

// nord-theme.ts
function hexToRGBA(hex, alpha) {
  const h = hex.replace("#", "");
  return {
    red: Number.parseInt(h.substring(0, 2), 16) / 255,
    green: Number.parseInt(h.substring(2, 4), 16) / 255,
    blue: Number.parseInt(h.substring(4, 6), 16) / 255,
    alpha
  };
}
function canvasColor(hex, alpha = 1) {
  return hexToRGBA(hex, alpha);
}
function chooserColor(hex) {
  return HSColor.hex(hex);
}
var Nord = {
  nord0: "#2E3440",
  nord0Dark: "#252933",
  nord1: "#3B4252",
  nord2: "#434C5E",
  nord3: "#4C566A",
  nord4: "#D8DEE9",
  nord5: "#E5E9F0",
  nord6: "#ECEFF4",
  nord7: "#8FBCBB",
  nord8: "#88C0D0",
  nord9: "#81A1C1",
  nord10: "#5E81AC",
  nord11: "#BF616A",
  nord12: "#D08770",
  nord13: "#EBCB8B",
  nord14: "#A3BE8C",
  nord15: "#B48EAD"
};
var FONT_SIZE = 12;
var Theme = {
  background: Nord.nord0Dark,
  backgroundAlpha: 1,
  surface: Nord.nord1,
  border: Nord.nord2,
  text: Nord.nord6,
  textMuted: Nord.nord4,
  textDim: Nord.nord3,
  accent: Nord.nord8,
  accentSecondary: Nord.nord9,
  error: Nord.nord11,
  warning: Nord.nord13,
  success: Nord.nord14,
  paddingX: 16,
  paddingY: 16,
  gap: 10,
  fontSize: FONT_SIZE,
  breadcrumbFontSize: 12,
  cornerRadius: 10,
  borderWidth: 1.5,
  // Descender headroom factor: multiplied onto a font size wherever a
  // canvas text element's frame height is set, so the box has room below
  // the baseline for descenders ("y"/"g"/"p") -- see leader-menu.ts.
  textFrameHeightMultiplier: 1.3,
  // "Square glyph slot" columns (app icon, key chip) share this formula.
  iconColW: FONT_SIZE + 10,
  keyChipSize: FONT_SIZE + 10,
  keyChipRadius: 4,
  imageIconSize: Math.floor(FONT_SIZE * 1.25),
  placeholderCanvasSize: 32,
  placeholderDotDiameter: 16,
  placeholderRingStrokeWidth: 1
};

// leader-menu.ts
var OVERLAY_LEVEL = hs.canvas.windowLevels["overlay"];
var KEY_DOWN = hs.eventtap.eventTypes["keyDown"];
var LEFT_MOUSE_DOWN = hs.eventtap.eventTypes["leftMouseDown"];
var RIGHT_MOUSE_DOWN = hs.eventtap.eventTypes["rightMouseDown"];
var OTHER_MOUSE_DOWN = hs.eventtap.eventTypes["otherMouseDown"];
var REVEAL_DELAY_SECONDS = 0.5;
var PLACEHOLDER_ENTER_DURATION = 0.2;
var SPLIT_TRANSITION_DURATION = 0.22;
var SLIDE_OFFSET_PX = 14;
var SPLIT_GAP_PX = 24;
function nowMs() {
  return hs.timer.absoluteTime() / 1e6;
}
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function animateCanvas(canvas2, opts) {
  const durationMs = (opts.duration ?? 0.15) * 1e3;
  const startMs = nowMs();
  const { fromPoint, toPoint } = opts;
  const tick = () => {
    const t = Math.min((nowMs() - startMs) / durationMs, 1);
    const e = easeOutCubic(t);
    canvas2.setTopLeft({
      x: fromPoint.x + (toPoint.x - fromPoint.x) * e,
      y: fromPoint.y + (toPoint.y - fromPoint.y) * e
    });
    return t >= 1;
  };
  if (tick()) {
    opts.onComplete?.();
    return null;
  }
  let timer;
  timer = hs.timer.create(1 / 60, () => {
    if (tick()) {
      timer.stop();
      animTimers.delete(timer);
      opts.onComplete?.();
    }
  });
  animTimers.add(timer);
  timer.start();
  return timer;
}
var canvas = null;
var placeholderCanvas = null;
var tap = null;
var mouseTap = null;
var stack = [];
var revealed = false;
var revealTimer = null;
var animTimers = /* @__PURE__ */ new Set();
var showStartMs = 0;
var watchedAppElement = null;
var onFocusedWindowChanged = (_notification, _element) => closeMenu("focus stolen");
function watchAppElement(app) {
  if (watchedAppElement) {
    hs.ax.off(watchedAppElement, "focusedWindowChanged", onFocusedWindowChanged);
    watchedAppElement = null;
  }
  const element = app?.axElement() ?? null;
  if (element) {
    hs.ax.on(element, "focusedWindowChanged", onFocusedWindowChanged);
    watchedAppElement = element;
  }
}
var onDidActivate = (app) => {
  watchAppElement(app);
  closeMenu("app activated");
};
function closeMenu(_source) {
  if (revealTimer) {
    revealTimer.stop();
    revealTimer = null;
  }
  for (const timer of animTimers) timer.stop();
  animTimers.clear();
  canvas?.destroy();
  canvas = null;
  placeholderCanvas?.destroy();
  placeholderCanvas = null;
  tap?.stop();
  tap = null;
  mouseTap?.stop();
  mouseTap = null;
  hs.application.off("didActivate", onDidActivate);
  if (watchedAppElement) {
    hs.ax.off(watchedAppElement, "focusedWindowChanged", onFocusedWindowChanged);
    watchedAppElement = null;
  }
  stack = [];
  revealed = false;
}
function cancelRevealTimer() {
  if (revealTimer) {
    revealTimer.stop();
    revealTimer = null;
  }
}
function armRevealTimer() {
  cancelRevealTimer();
  if (revealed) return;
  revealTimer = hs.timer.doAfter(REVEAL_DELAY_SECONDS, () => {
    revealTimer = null;
    revealMenu();
  });
}
function resolveIcon(opt) {
  if (opt.icon) return opt.icon;
  if (opt.action.kind === "app") {
    return HSImage.fromAppBundle(opt.action.bundleID);
  }
  return null;
}
function runShellCommand(path, args) {
  const task = hs.task.create(path, args, null, null, null);
  task.start();
}
function pushAndRenderSubmenu(submenuOptions, newBreadcrumb) {
  stack.push({ options: submenuOptions, breadcrumb: newBreadcrumb });
  if (revealed) renderMenu(submenuOptions, newBreadcrumb);
  bindKeys(submenuOptions, newBreadcrumb);
}
function selectOption(opt, breadcrumb) {
  const action = opt.action;
  switch (action.kind) {
    case "submenu": {
      const newBreadcrumb = [...breadcrumb, opt.label];
      const resolved = typeof action.submenu === "function" ? action.submenu() : action.submenu;
      if (resolved instanceof Promise) {
        void resolved.then((items) => pushAndRenderSubmenu(items, newBreadcrumb));
      } else {
        pushAndRenderSubmenu(resolved, newBreadcrumb);
      }
      break;
    }
    case "app":
      closeMenu("app launched");
      void hs.application.launchOrFocus(action.bundleID);
      break;
    case "cmd":
      closeMenu("cmd started");
      runShellCommand(action.path, action.args ?? []);
      break;
    case "url":
      closeMenu("url opened");
      hs.urlevent.openURL(action.url);
      break;
    case "callback":
      closeMenu("callback called");
      action.run();
      break;
  }
}
function placeholderRestTopLeft(half) {
  const sf = hs.screen.main().frame;
  const size = Theme.placeholderCanvasSize;
  const centerX = sf.x + sf.w / 2;
  const cy = sf.y + sf.h / 2;
  if (half === "left") {
    return { x: centerX - SPLIT_GAP_PX / 2 - size, y: cy - size / 2 };
  }
  return { x: centerX - size / 2, y: cy - size / 2 };
}
function menuRestTopLeft(w, h) {
  const sf = hs.screen.main().frame;
  const centerX = sf.x + sf.w / 2;
  return { x: centerX + SPLIT_GAP_PX / 2, y: sf.y + (sf.h - h) / 2 };
}
function buildPlaceholderCanvas(topLeft) {
  const size = Theme.placeholderCanvasSize;
  const c = hs.canvas.create({ x: topLeft.x, y: topLeft.y, w: size, h: size });
  c.appendElements([
    {
      type: "circle",
      action: "fill",
      fillColor: canvasColor(Theme.background, Theme.backgroundAlpha),
      center: { x: size / 2, y: size / 2 },
      radius: size / 2
    },
    {
      type: "circle",
      action: "stroke",
      strokeColor: canvasColor(Theme.border),
      strokeWidth: Theme.placeholderRingStrokeWidth,
      center: { x: size / 2, y: size / 2 },
      radius: size / 2 - 0.5
    },
    {
      type: "circle",
      action: "fill",
      fillColor: canvasColor(Theme.border),
      center: { x: size / 2, y: size / 2 },
      radius: Theme.placeholderDotDiameter / 2
    }
  ]);
  c.levelValue(OVERLAY_LEVEL);
  c.clickActivating(false);
  return c;
}
function showPlaceholderInitial() {
  const rest = placeholderRestTopLeft("screen");
  const start = { x: rest.x, y: rest.y + SLIDE_OFFSET_PX };
  const c = buildPlaceholderCanvas(start);
  c.show();
  placeholderCanvas = c;
  animateCanvas(c, { fromPoint: start, toPoint: rest, duration: PLACEHOLDER_ENTER_DURATION });
}
function revealMenu() {
  if (revealed) return;
  revealed = true;
  cancelRevealTimer();
  if (placeholderCanvas) {
    const leftRest = placeholderRestTopLeft("left");
    animateCanvas(placeholderCanvas, {
      fromPoint: placeholderCanvas.topLeft(),
      toPoint: leftRest,
      duration: SPLIT_TRANSITION_DURATION
    });
  }
  const top = stack[stack.length - 1];
  renderMenu(top.options, top.breadcrumb, { entering: true });
}
function renderMenu(options, breadcrumb, opts = {}) {
  canvas?.destroy();
  const { paddingX, paddingY, fontSize, breadcrumbFontSize, gap } = Theme;
  const breadcrumbSpace = gap + breadcrumbFontSize;
  const w = 320;
  let h = paddingY * 2 + options.length * (fontSize + gap) - gap;
  if (breadcrumb.length > 0) h += breadcrumbSpace;
  const restTopLeft = menuRestTopLeft(w, h);
  const { x, y } = restTopLeft;
  const c = hs.canvas.create({ x, y, w, h });
  c.appendElements([
    {
      type: "rectangle",
      action: "strokeAndFill",
      fillColor: canvasColor(Theme.background, Theme.backgroundAlpha),
      strokeColor: canvasColor(Theme.border),
      strokeWidth: Theme.borderWidth,
      roundedRectRadii: { xRadius: Theme.cornerRadius, yRadius: Theme.cornerRadius }
    }
  ]);
  let yOffset = paddingY;
  if (breadcrumb.length > 0) {
    c.appendElements([
      {
        type: "text",
        text: breadcrumb.join(" > "),
        textColor: canvasColor(Theme.textDim),
        textSize: breadcrumbFontSize,
        frame: { x: paddingX, y: paddingY, w: w - paddingX * 2, h: breadcrumbFontSize * Theme.textFrameHeightMultiplier }
      }
    ]);
    yOffset += breadcrumbSpace;
  }
  const iconColX = paddingX;
  const iconColW = Theme.iconColW;
  const iconGap = 8;
  const keyColX = iconColX + iconColW + iconGap;
  const keyColW = Theme.keyChipSize;
  const keyGap = 8;
  const textX = keyColX + keyColW + keyGap;
  const rowTextH = fontSize * Theme.textFrameHeightMultiplier;
  options.forEach((opt, i) => {
    const rowY = yOffset + i * (fontSize + gap);
    const id = i + 1;
    const icon2 = resolveIcon(opt);
    if (icon2) {
      if (typeof icon2 === "string") {
        c.appendElements([
          {
            type: "text",
            text: icon2,
            textSize: fontSize,
            textAlignment: "center",
            textFont: "JetBrainsMono Nerd Font",
            frame: { x: iconColX, y: rowY, w: iconColW, h: rowTextH },
            id,
            trackMouseDown: true
          }
        ]);
      } else {
        const imageSize = Theme.imageIconSize;
        c.appendElements([
          {
            type: "image",
            image: icon2,
            imageScaling: "scaleProportionally",
            frame: { x: iconColX + (iconColW - imageSize) / 2, y: rowY, w: imageSize, h: imageSize },
            id,
            trackMouseDown: true
          }
        ]);
      }
    }
    c.appendElements([
      {
        type: "rectangle",
        action: "fill",
        fillColor: canvasColor(Theme.surface),
        roundedRectRadii: { xRadius: Theme.keyChipRadius, yRadius: Theme.keyChipRadius },
        frame: { x: keyColX, y: rowY, w: keyColW, h: rowTextH },
        id,
        trackMouseDown: true
      },
      {
        type: "text",
        text: opt.key,
        textColor: canvasColor(Theme.text),
        textWeight: "bold",
        textSize: fontSize,
        textAlignment: "center",
        frame: { x: keyColX, y: rowY, w: keyColW, h: rowTextH },
        id,
        trackMouseDown: true
      }
    ]);
    const arrowW = opt.action.kind === "submenu" ? 24 : 0;
    c.appendElements([
      {
        type: "text",
        text: opt.label,
        textColor: canvasColor(Theme.text),
        textSize: fontSize,
        frame: { x: textX, y: rowY, w: w - textX - paddingX - arrowW, h: rowTextH },
        id,
        trackMouseDown: true
      }
    ]);
    if (opt.action.kind === "submenu") {
      c.appendElements([
        {
          type: "text",
          text: "\u2192",
          textColor: canvasColor(Theme.textDim),
          textSize: fontSize,
          frame: { x: w - paddingX - arrowW, y: rowY, w: arrowW, h: rowTextH },
          id,
          trackMouseDown: true
        }
      ]);
    }
  });
  c.levelValue(OVERLAY_LEVEL);
  c.clickActivating(false);
  c.mouseCallback((_canvas, message, id) => {
    if (message !== "mouseDown") return;
    const opt = options[id - 1];
    if (opt) selectOption(opt, breadcrumb);
  });
  if (opts.entering) {
    const restPos = { x, y };
    const startPos = { x, y: y + SLIDE_OFFSET_PX };
    c.setTopLeft(startPos);
    c.show();
    animateCanvas(c, { fromPoint: startPos, toPoint: restPos, duration: SPLIT_TRANSITION_DURATION });
  } else {
    c.show();
  }
  canvas = c;
}
function bindKeys(options, breadcrumb) {
  tap?.stop();
  tap = hs.eventtap.addWatcher(
    [KEY_DOWN],
    (event) => {
      armRevealTimer();
      const codeMap = hs.keycodes.map;
      let pressed = String(codeMap[String(event.keyCode)] ?? "");
      if (event.flags.includes("shift") && pressed.length === 1 && /[a-z]/i.test(pressed)) {
        pressed = pressed.toUpperCase();
      }
      if (pressed === "escape") {
        closeMenu("esc pressed");
        return hs.eventtap.consume;
      }
      if (pressed === "delete") {
        if (stack.length <= 1) {
          closeMenu("backspace at root");
        } else {
          stack.pop();
          const parent = stack[stack.length - 1];
          if (revealed) renderMenu(parent.options, parent.breadcrumb);
          bindKeys(parent.options, parent.breadcrumb);
        }
        return hs.eventtap.consume;
      }
      for (const opt of options) {
        if (pressed === opt.key) {
          selectOption(opt, breadcrumb);
          return hs.eventtap.consume;
        }
      }
      return hs.eventtap.consume;
    },
    false
  );
  if (!tap) {
    hs.ui.alert("Leader menu: eventtap failed to start \u2014 check Accessibility permissions").show();
    closeMenu("listening failed to start");
    return;
  }
  tap.start();
}
function withinCanvas(point) {
  if (!canvas) return false;
  const f = canvas.frame();
  return point.x >= f.x && point.x <= f.x + f.w && point.y >= f.y && point.y <= f.y + f.h;
}
function startMouseWatcher() {
  mouseTap?.stop();
  mouseTap = hs.eventtap.addWatcher(
    [
      LEFT_MOUSE_DOWN,
      RIGHT_MOUSE_DOWN,
      OTHER_MOUSE_DOWN
    ],
    (event) => {
      const loc = event.location;
      if (!withinCanvas(loc)) closeMenu("click outside");
      return hs.eventtap.emit;
    },
    false
  );
  mouseTap?.start();
}
function startFocusWatcher() {
  hs.application.on("didActivate", onDidActivate);
  watchAppElement(hs.application.frontmost());
}
function show(menuTree2) {
  showStartMs = nowMs();
  closeMenu("close at the start");
  stack = [{ options: menuTree2, breadcrumb: [] }];
  showPlaceholderInitial();
  bindKeys(menuTree2, []);
  startMouseWatcher();
  startFocusWatcher();
  armRevealTimer();
}

// emoji-picker.ts
var FREQUENCY_KEY = "emojiPicker.frequency";
var FREQUENT_PIN_COUNT = 12;
var EMOJI_DATA_PATH = hs.fs.homeDirectory() + "/.hammerspoon/v2/emojis.json";
var chooser = null;
var allChoices = [];
function loadFrequency() {
  return hs.userdefaults.get(FREQUENCY_KEY) ?? {};
}
function onSelect(choice, previouslyFocused) {
  previouslyFocused?.focus();
  if (!choice) return;
  const char = choice["char"];
  hs.eventtap.keyStrokes(char);
  const freq = loadFrequency();
  freq[char] = (freq[char] ?? 0) + 1;
  hs.userdefaults.set(FREQUENCY_KEY, freq);
}
function loadDataset() {
  const attrs = hs.fs.attributes(EMOJI_DATA_PATH);
  if (!attrs?.size) return [];
  const contents = hs.fs.read(EMOJI_DATA_PATH, 0, attrs.size);
  if (!contents) return [];
  try {
    return JSON.parse(contents);
  } catch {
    return [];
  }
}
function ensureLoaded() {
  if (chooser) return;
  allChoices = loadDataset();
  chooser = hs.chooser.create();
  chooser.visibleRows = 9;
  chooser.width = 0.3;
  chooser.searchSubText = true;
  chooser.placeholder = "Search emoji\u2026";
  chooser.backgroundColor = chooserColor(Theme.background);
  chooser.borderColor = chooserColor(Theme.border);
  chooser.cornerRadius = Theme.cornerRadius;
  chooser.textColor = chooserColor(Theme.text);
  chooser.subTextColor = chooserColor(Theme.textDim);
}
function buildRankedChoices() {
  const freq = loadFrequency();
  const frequent = allChoices.filter((c) => (freq[c.char] ?? 0) > 0);
  const rest = allChoices.filter((c) => (freq[c.char] ?? 0) <= 0);
  frequent.sort((a, b) => (freq[b.char] ?? 0) - (freq[a.char] ?? 0));
  return [...frequent.slice(0, FREQUENT_PIN_COUNT), ...rest, ...frequent.slice(FREQUENT_PIN_COUNT)];
}
function show2() {
  ensureLoaded();
  const c = chooser;
  const previouslyFocused = hs.window.focusedWindow();
  c.onSelect = (choice) => onSelect(choice, previouslyFocused);
  c.setChoices(buildRankedChoices());
  c.query = "";
  c.show();
}

// menu-item-search.ts
var chooser2 = null;
var currentApp = null;
function flatten(items, ancestorTitles, out) {
  for (const item of items ?? []) {
    const title = item.title;
    if (!title) continue;
    if (item.items && item.items.length > 0) {
      flatten(item.items, [...ancestorTitles, title], out);
    } else if (item.enabled !== false) {
      out.push({
        text: title,
        subText: ancestorTitles.length > 0 ? ancestorTitles.join(" \u2192 ") : void 0,
        path: [...ancestorTitles, title]
      });
    }
  }
}
function ensureLoaded2() {
  if (chooser2) return;
  chooser2 = hs.chooser.create();
  chooser2.visibleRows = 9;
  chooser2.width = 0.35;
  chooser2.searchSubText = true;
  chooser2.placeholder = "Filter by menu item title\u2026";
  chooser2.backgroundColor = chooserColor(Theme.background);
  chooser2.borderColor = chooserColor(Theme.border);
  chooser2.cornerRadius = Theme.cornerRadius;
  chooser2.textColor = chooserColor(Theme.text);
  chooser2.subTextColor = chooserColor(Theme.textDim);
  chooser2.onSelect = (choice) => {
    if (choice && currentApp) currentApp.selectMenuItemByPath(choice["path"]);
  };
}
function show3() {
  const app = hs.application.frontmost();
  if (!app) return;
  currentApp = app;
  ensureLoaded2();
  hs.ui.alert("Loading menu items\u2026").duration(1).show();
  const menuItems = app.getMenuItems();
  if (!menuItems) return;
  const choices = [];
  flatten(menuItems, [], choices);
  if (choices.length === 0) return;
  const c = chooser2;
  c.setChoices(choices);
  c.query = "";
  c.show();
}

// app-picker.ts
var APP_DIRS = [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  hs.fs.homeDirectory() + "/Applications"
];
var chooser3 = null;
var allChoices2 = [];
function styleChooser(c) {
  c.width = 0.3;
  c.backgroundColor = chooserColor(Theme.background);
  c.borderColor = chooserColor(Theme.border);
  c.cornerRadius = Theme.cornerRadius;
  c.textColor = chooserColor(Theme.text);
  c.subTextColor = chooserColor(Theme.textDim);
}
function bundleIDForPath(path) {
  const info = hs.plist.fromFile(`${path}/Contents/Info.plist`);
  const id = info?.["CFBundleIdentifier"];
  return typeof id === "string" ? id : null;
}
function focusWindow(win) {
  if (win.isMinimized) win.unminimize();
  win.focus();
}
function showWindowChooser(windows) {
  const c = hs.chooser.create();
  styleChooser(c);
  c.visibleRows = Math.min(windows.length, 9);
  c.placeholder = "Choose window\u2026";
  c.setChoices(
    windows.map((win) => ({
      text: win.title || "Untitled",
      winIndex: windows.indexOf(win)
    }))
  );
  c.onSelect = (choice) => {
    if (!choice) return;
    const win = windows[choice["winIndex"]];
    if (win) focusWindow(win);
  };
  c.show();
}
async function onSelect2(choice) {
  if (!choice) return;
  const path = choice["path"];
  const bundleID = bundleIDForPath(path);
  const app = bundleID ? hs.application.matchingBundleID(bundleID) : null;
  if (!app) {
    if (bundleID) await hs.application.launchOrFocus(bundleID);
    return;
  }
  const windows = app.allWindows.filter((w) => w.isStandard);
  if (windows.length === 0) {
    app.activate();
  } else if (windows.length === 1) {
    focusWindow(windows[0]);
  } else {
    showWindowChooser(windows);
  }
}
function scanApps() {
  const choices = [];
  for (const dir of APP_DIRS) {
    let names;
    try {
      names = hs.fs.list(dir);
    } catch {
      continue;
    }
    if (!names) continue;
    for (const name of names) {
      if (!name.endsWith(".app")) continue;
      const path = `${dir}/${name}`;
      choices.push({
        text: name.replace(/\.app$/, ""),
        subText: path,
        path,
        image: HSImage.iconForFile(path)
      });
    }
  }
  choices.sort((a, b) => a.text.localeCompare(b.text));
  return choices;
}
function ensureLoaded3() {
  if (chooser3) return;
  allChoices2 = scanApps();
  chooser3 = hs.chooser.create();
  styleChooser(chooser3);
  chooser3.visibleRows = 9;
  chooser3.searchSubText = true;
  chooser3.placeholder = "Open or focus app\u2026";
  chooser3.onSelect = (choice) => void onSelect2(choice);
}
function show4() {
  ensureLoaded3();
  const c = chooser3;
  c.setChoices(allChoices2);
  c.query = "";
  c.show();
}

// process-explorer.ts
async function parseProcesses() {
  const { stdout } = await hs.task.shell("ps -axo pid,ppid,pcpu,rss,comm", {});
  const byPid = /* @__PURE__ */ new Map();
  const childrenOf = /* @__PURE__ */ new Map();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    byPid.set(pid, {
      pid,
      ppid,
      cpu: Number(m[3]),
      memMB: Number(m[4]) / 1024,
      comm: m[5],
      children: []
    });
    const kids = childrenOf.get(ppid) ?? [];
    kids.push(pid);
    childrenOf.set(ppid, kids);
  }
  for (const [ppid, kids] of childrenOf) {
    const rec = byPid.get(ppid);
    if (rec) rec.children = kids;
  }
  byPid.set(0, { pid: 0, ppid: -1, cpu: null, memMB: null, comm: "kernel_task", children: childrenOf.get(0) ?? [] });
  return byPid;
}
function rootPids(byPid) {
  return [0, 1, ...byPid.get(1)?.children ?? []];
}
function iconForPid(pid, comm) {
  const app = hs.application.fromPID(pid);
  const bundlePath = app?.bundlePath ?? comm.match(/^(.*?\.app)\//)?.[1];
  return bundlePath ? HSImage.iconForFile(bundlePath) : null;
}
function processRow(record) {
  return {
    text: record.comm.match(/([^/]+)$/)?.[1] ?? record.comm,
    subText: `PID ${record.pid} \xB7 ${record.cpu !== null ? record.cpu.toFixed(1) + "% CPU" : "\u2014 CPU"} \xB7 ${record.memMB !== null ? Math.round(record.memMB) + " MB" : "\u2014 MB"} \xB7 ${record.children.length} children`,
    image: iconForPid(record.pid, record.comm),
    pid: record.pid
  };
}
function hammerspoonOwnPid() {
  return hs.appinfo.pid;
}
async function killProcess(pid, signal) {
  if (pid === 0 || pid === 1 || pid === hammerspoonOwnPid()) {
    hs.ui.alert(`Refusing to kill pid ${pid}`).show();
    return;
  }
  await hs.task.shell(`kill ${signal === "KILL" ? "-KILL" : "-TERM"} ${pid}`, {});
}
function styleChooser2(c) {
  c.width = 0.35;
  c.backgroundColor = chooserColor(Theme.background);
  c.borderColor = chooserColor(Theme.border);
  c.cornerRadius = Theme.cornerRadius;
  c.textColor = chooserColor(Theme.text);
  c.subTextColor = chooserColor(Theme.textDim);
}
function showLevelChooser(pids, byPid) {
  const records = pids.map((pid) => byPid.get(pid)).filter((r) => r !== void 0);
  records.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
  const c = hs.chooser.create();
  styleChooser2(c);
  c.visibleRows = 9;
  c.searchSubText = true;
  c.placeholder = "Browse processes\u2026";
  c.setChoices(records.map(processRow));
  c.onSelect = (choice) => {
    if (!choice) return;
    const record = byPid.get(choice["pid"]);
    if (record) showActionsChooser(record, byPid);
  };
  c.show();
}
function showActionsChooser(record, byPid) {
  const name = record.comm.match(/([^/]+)$/)?.[1] ?? record.comm;
  const choices = [
    { text: "Kill (SIGTERM)", subText: `Ask ${name} (pid ${record.pid}) to quit`, kind: "term" },
    { text: "Force Kill (SIGKILL)", subText: `Immediately terminate ${name} (pid ${record.pid})`, kind: "kill" }
  ];
  if (record.children.length > 0) {
    choices.push({ text: `View ${record.children.length} children \u2192`, subText: name, kind: "children" });
  }
  const c = hs.chooser.create();
  styleChooser2(c);
  c.visibleRows = Math.min(choices.length, 9);
  c.placeholder = name;
  c.setChoices(choices);
  c.onSelect = (choice) => {
    if (!choice) return;
    if (choice["kind"] === "term") void killProcess(record.pid, "TERM");
    else if (choice["kind"] === "kill") void killProcess(record.pid, "KILL");
    else if (choice["kind"] === "children") showLevelChooser(record.children, byPid);
  };
  c.show();
}
async function show5() {
  const byPid = await parseProcesses();
  showLevelChooser(rootPids(byPid), byPid);
}

// key-labels.ts
var SINGLE_CHARS = [
  "a",
  "s",
  "d",
  "f",
  "g",
  "h",
  "j",
  "k",
  "l"
];
function capacity(single = SINGLE_CHARS) {
  return single.length;
}
function generate(count, single = SINGLE_CHARS) {
  return single.slice(0, Math.min(count, single.length));
}

// zellij-menu.ts
async function runLines(cmd) {
  const { stdout } = await hs.task.shell(cmd, {});
  return stdout.split(/\r?\n/).filter((line) => line.length > 0);
}
async function runJson(cmd) {
  const { stdout } = await hs.task.shell(cmd, {});
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
async function listSessions() {
  const lines = await runLines("zellij list-sessions --no-formatting");
  const sessions = [];
  for (const line of lines) {
    const name = line.match(/^(\S+)/)?.[1];
    if (name) sessions.push({ name, exited: line.includes("EXITED") });
  }
  return sessions;
}
async function liveSessionNames() {
  return (await listSessions()).filter((s) => !s.exited).map((s) => s.name);
}
var currentSession = null;
async function detectAttachedSession() {
  for (const name of await liveSessionNames()) {
    const { exitCode, stdout } = await hs.task.shell(
      `zellij --session ${shellQuote(name)} action list-clients`,
      {}
    );
    if (exitCode !== 0) continue;
    for (const line of stdout.split(/\r?\n/)) {
      if (/^\d/.test(line)) return name;
    }
  }
  return null;
}
async function resolveCurrentSession() {
  if (!currentSession) currentSession = await detectAttachedSession();
  if (!currentSession) hs.ui.alert("Zellij: no session currently attached").show();
  return currentSession;
}
var ALACRITTY_BUNDLE_ID = "io.alacritty";
function focusAlacritty() {
  void hs.application.launchOrFocus(ALACRITTY_BUNDLE_ID);
}
async function switchToSession(name) {
  const current = await resolveCurrentSession();
  if (current) {
    await hs.task.shell(
      `zellij --session ${shellQuote(current)} action switch-session ${shellQuote(name)}`,
      {}
    );
  }
  currentSession = name;
  focusAlacritty();
}
function capped(list) {
  return list.slice(0, capacity());
}
async function sessionsSubmenu() {
  const names = capped(await liveSessionNames());
  const labels = generate(names.length);
  return names.map((name, i) => ({
    key: labels[i],
    label: name,
    action: { kind: "callback", run: () => void switchToSession(name) }
  }));
}
async function tabsSubmenu() {
  const current = await resolveCurrentSession();
  if (!current) return [];
  const tabs = capped(
    await runJson(`zellij --session ${shellQuote(current)} action list-tabs --json`) ?? []
  );
  const labels = generate(tabs.length);
  return tabs.map((tab, i) => ({
    key: labels[i],
    label: tab.name,
    action: {
      kind: "callback",
      run: () => {
        void hs.task.shell(`zellij --session ${shellQuote(current)} action go-to-tab-name ${shellQuote(tab.name)}`, {}).then(() => focusAlacritty());
      }
    }
  }));
}
async function reviveSubmenu() {
  const exited = capped((await listSessions()).filter((s) => s.exited).map((s) => s.name));
  const labels = generate(exited.length);
  return exited.map((name, i) => ({
    key: labels[i],
    label: name,
    action: {
      kind: "callback",
      // Resurrects it as a live background session (no client attached
      // yet) -- succeeds without disturbing whatever's currently attached
      // elsewhere.
      run: () => {
        void hs.task.shell(`zellij attach --create-background ${shellQuote(name)}`, {}).then(() => switchToSession(name));
      }
    }
  }));
}
var node = {
  key: "z",
  label: "Zellij",
  action: {
    kind: "submenu",
    submenu: [
      { key: "s", label: "Switch session", action: { kind: "submenu", submenu: sessionsSubmenu } },
      { key: "t", label: "Switch tab", action: { kind: "submenu", submenu: tabsSubmenu } },
      { key: "r", label: "Revive session", action: { kind: "submenu", submenu: reviveSubmenu } }
    ]
  }
};

// leader-menu-config.ts
function icon(codepoint) {
  return String.fromCodePoint(codepoint);
}
var APP_BUNDLE_IDS = {
  zed: "dev.zed.Zed",
  arc: "company.thebrowser.Browser",
  telegram: "ru.keepcoder.Telegram",
  vscode: "com.microsoft.VSCode",
  messages: "com.apple.MobileSMS",
  safari: "com.apple.Safari",
  bear: "net.shinyfrog.bear",
  onePassword: "com.1password.1password",
  zenBrowser: "app.zen-browser.zen"
};
function appItem(key, label, bundleID) {
  return { key, label, action: { kind: "app", bundleID } };
}
function setWindowFrame(widthFraction, position) {
  const win = hs.window.focusedWindow();
  if (!win) return;
  const screenFrame = win.screen?.frame;
  if (!screenFrame) return;
  const width = screenFrame.w * widthFraction;
  let x = screenFrame.x;
  if (position === "right") x = screenFrame.x + screenFrame.w - width;
  else if (position === "center") x = screenFrame.x + (screenFrame.w - width) / 2;
  win.frame = { x, y: screenFrame.y, w: width, h: screenFrame.h };
}
function maximizeFocusedWindow() {
  hs.window.focusedWindow()?.raise();
  const win = hs.window.focusedWindow();
  if (win) hs.window.maximize(win);
}
function toggleFullScreenFocusedWindow() {
  hs.window.focusedWindow()?.toggleFullscreen();
}
function dailyNotePath() {
  const now = /* @__PURE__ */ new Date();
  const mon = now.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = String(now.getDate()).padStart(2, "0");
  const dow = now.toLocaleString("en-US", { weekday: "short" }).toLowerCase();
  const dir = `${hs.fs.homeDirectory()}/work/journal/${mon}`;
  return { path: `${dir}/${day}-${dow}.md`, dir };
}
function openDailyNote() {
  const { path, dir } = dailyNotePath();
  hs.fs.mkdir(dir);
  if (!hs.fs.attributes(path)) hs.fs.write(path, "");
  summon("journal", "hx " + shellQuote(path));
}
var menuTree = [
  { key: "t", label: "Alacritty", action: { kind: "app", bundleID: "io.alacritty" } },
  {
    key: "r",
    label: "Resize window",
    icon: icon(61449),
    // th-large
    action: {
      kind: "submenu",
      submenu: [
        { key: "h", label: "Left 1/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 3, "left") } },
        { key: "l", label: "Right 1/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 3, "right") } },
        { key: "j", label: "Left 2/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(2 / 3, "left") } },
        { key: "k", label: "Right 2/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(2 / 3, "right") } },
        { key: "m", label: "Maximize", icon: icon(62160), action: { kind: "callback", run: maximizeFocusedWindow } },
        { key: ",", label: "Center 2/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(2 / 3, "center") } },
        { key: ".", label: "Center 1/2", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 2, "center") } },
        { key: "H", label: "Left 1/2", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 2, "left") } },
        { key: "L", label: "Right 1/2", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 2, "right") } },
        { key: "f", label: "Full screen", icon: icon(61541), action: { kind: "callback", run: toggleFullScreenFocusedWindow } }
      ]
    }
  },
  { key: "b", label: "Zen Browser", action: { kind: "app", bundleID: APP_BUNDLE_IDS.zenBrowser } },
  {
    key: "f",
    label: "Hide others",
    icon: icon(61606),
    // hand-o-up
    action: { kind: "url", url: "raycast://extensions/raycast/system/hide-all-apps-except-frontmost" }
  },
  {
    key: "s",
    label: "Screenshots",
    icon: icon(61488),
    // camera
    action: {
      kind: "submenu",
      submenu: [
        { key: "y", label: "Screenshot", icon: icon(61488), action: { kind: "cmd", path: "/usr/sbin/screencapture", args: ["-ci"] } },
        { key: "a", label: "Show app", icon: "?", action: { kind: "url", url: "shottr://show" } },
        { key: "s", label: "Area screenshot", icon: icon(61733), action: { kind: "url", url: "shottr://grab/area?then=copy" } },
        { key: "r", label: "repeat screenshot then edit", icon: icon(61733), action: { kind: "url", url: "shottr://grab/repeat?then=edit" } },
        { key: "w", label: "Window screenshot", icon: icon(62162), action: { kind: "url", url: "shottr://grab/window" } }
      ]
    }
  },
  {
    key: "e",
    label: "Pick emoji",
    icon: icon(61720),
    // smile-o
    action: { kind: "url", url: "raycast://extensions/raycast/emoji-symbols/search-emoji-symbols" }
  },
  {
    key: "E",
    label: "Pick emoji (native)",
    icon: icon(61720),
    action: { kind: "callback", run: () => show2() }
  },
  {
    key: "d",
    label: "Apps",
    icon: icon(61704),
    // desktop
    action: {
      kind: "submenu",
      submenu: [
        appItem("t", "Telegram", APP_BUNDLE_IDS.telegram),
        appItem("z", "Zed", APP_BUNDLE_IDS.zed),
        appItem("a", "Arc", APP_BUNDLE_IDS.arc),
        appItem("v", "VS Code", APP_BUNDLE_IDS.vscode),
        appItem("m", "Messages", APP_BUNDLE_IDS.messages),
        appItem("s", "Safari", APP_BUNDLE_IDS.safari),
        appItem("b", "Bear", APP_BUNDLE_IDS.bear),
        appItem("p", "1Password", APP_BUNDLE_IDS.onePassword)
      ]
    }
  },
  {
    key: "m",
    label: "Search menu items",
    icon: icon(61641),
    // bars
    action: { kind: "callback", run: () => show3() }
  },
  {
    key: "/",
    label: "Open or focus app",
    icon: icon(61442),
    // search
    action: { kind: "callback", run: () => show4() }
  },
  {
    key: "p",
    label: "Process explorer",
    icon: icon(61672),
    // sitemap
    action: { kind: "callback", run: () => void show5() }
  },
  {
    key: "a",
    label: "Arc actions",
    icon: icon(61445),
    // star (no bundle icon lookup here, unlike v1's hs.image.iconForFile(path) -- v2's icon
    // path needs the resolved .app path, which this config doesn't look up for icon-only purposes
    action: {
      kind: "submenu",
      submenu: [
        { key: "a", label: "Select space", icon: icon(61445), action: { kind: "url", url: "raycast://extensions/the-browser-company/arc/search-spaces" } },
        { key: "s", label: "Search tab", icon: icon(61442), action: { kind: "url", url: "raycast://extensions/the-browser-company/arc/search-tabs" } },
        {
          key: "t",
          label: "new tab",
          icon: icon(61694),
          action: {
            kind: "url",
            url: "raycast://extensions/the-browser-company/arc/new-tab?arguments=%7B%22space%22%3A%22%22%2C%22url%22%3A%22%22%7D"
          }
        }
      ]
    }
  },
  {
    key: "u",
    label: "Utilities",
    icon: icon(61761),
    // ellipsis-h
    action: {
      kind: "submenu",
      submenu: [
        {
          key: "m",
          label: "Music",
          action: {
            kind: "submenu",
            submenu: [
              { key: ",", label: "Play/Pause", action: { kind: "url", url: "raycast://extensions/fedevitaledev/music/toggle-play-pause" } }
            ]
          }
        },
        {
          key: "g",
          label: "View google cal event",
          icon: icon(61555),
          // calendar
          action: { kind: "url", url: "raycast://extensions/thomas/google-calendar/list-events" }
        },
        {
          key: "x",
          label: "Tuxedo",
          icon: icon(61728),
          // terminal
          action: { kind: "callback", run: () => summon("tuxedo", "tuxedo") }
        },
        {
          key: "n",
          label: "Nushell",
          icon: icon(61728),
          action: { kind: "callback", run: () => summon("nu", void 0, " --shell nu") }
        },
        {
          key: "y",
          label: "Yazi",
          icon: icon(61728),
          action: {
            kind: "callback",
            run: () => summon("yazi", "yazi", " --cwd " + shellQuote(hs.fs.homeDirectory()))
          }
        },
        {
          key: "h",
          label: "Find file (Helix)",
          icon: icon(61728),
          action: {
            kind: "callback",
            run: () => {
              pick("file-picker", "fzf", "~/work", (picked) => {
                const path = /^[~/]/.test(picked) ? picked : "~/work/" + picked;
                summon("helix", "hx " + shellQuote(path));
              });
            }
          }
        },
        {
          key: "d",
          label: "Daily note",
          icon: icon(61728),
          action: { kind: "callback", run: openDailyNote }
        },
        {
          key: "r",
          label: "Reload config",
          icon: icon(61473),
          // refresh
          action: { kind: "callback", run: () => hs.reload() }
        }
      ]
    }
  },
  node
];

// init.ts
var hyper = ["cmd", "alt", "ctrl", "shift"];
var hotkeys = [
  hs.hotkey.bind(hyper, "t", () => summon("tuxedo", "tuxedo"), null),
  hs.hotkey.bind(
    hyper,
    "y",
    () => summon(
      "yazi",
      "yazi",
      ` --cwd ${shellQuote(hs.fs.homeDirectory())}`
    ),
    null
  ),
  // LEADER MENU (Hyper+M) -- LeaderKey-style popup.
  hs.hotkey.bind(hyper, "m", () => show(menuTree), null)
];
