// yanpresence.app's own executable: the menu bar icon, and the process the
// rest of the app runs under.
//
// On Windows the app is a hidden Node process with a PowerShell child drawing
// its notification-area icon. Here the parent and child swap places: this is
// what LaunchServices starts, it draws the icon, and it runs the bundled Node
// app as its child. Three things force that shape.
//
//   - Automation permission belongs to the "responsible" process, which is the
//     one LaunchServices launched. Node and the osascript watchers it starts
//     inherit this app as theirs, so macOS asks whether *yanpresence* may
//     control Music -- with this bundle's name, icon and usage string -- and
//     remembers the answer for the app rather than for a node binary.
//   - LaunchServices treats the app as running only while this process is. So
//     opening it again reaches the running copy instead of starting a second,
//     and Open at Login and logging out talk to it as they would to any app.
//   - An AppKit run loop is not something Node can host, any more than it can
//     host the WinForms message loop on Windows.
//
// Node talks to it over a socket on fd 3, named by YANPRESENCE_MENU_FD. The
// lines sent from here are the ones the Windows tray prints -- "ready", "quit",
// "artist-photo on" and "artist-photo off" -- so src/tray.js reads both alike.
// The lines from Node are JSON, one object each:
//
//   {"type":"hello","logFile":"...","artistPhoto":true}  once, at startup
//   {"type":"status","tooltip":"...","line":"..."}        what the card says
//   {"type":"fatal","message":"...","logFile":"..."}      could not start
//
// Built by scripts/build-macos.sh, which compiles this one file.

import AppKit
import ServiceManagement

let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "yanpresence"
let bundleID = Bundle.main.bundleIdentifier ?? "com.ethanyanxu.yanpresence"

// MARK: - The Node process

/// The bundled Node app, run as a child: spawned, talked to, and noticed when
/// it exits.
///
/// posix_spawn rather than Process, because Process hands a child exactly
/// three descriptors and the channel is a fourth.
@MainActor
final class Engine {
  let node: URL
  let entry: URL

  private(set) var pid: pid_t = 0
  private(set) var startedAt = Date()
  /// This end of the socket to Node, nil once it has closed.
  private var channel: FileHandle?
  private var stderrReader: FileHandle?
  private var exitSource: DispatchSourceProcess?
  private var buffer = Data()
  private var exitStatus: (code: Int32?, signal: Int32?)?
  private var reported = false

  /// The last of what Node wrote to stderr. Its log file has everything it
  /// logged; this is for what it never got the chance to: an uncaught
  /// exception, or a failure before the log file was opened.
  private(set) var stderrTail = Data()

  var onMessage: (([String: Any]) -> Void)?
  var onExit: ((_ code: Int32?, _ signal: Int32?) -> Void)?

  var isRunning: Bool { pid > 0 && exitStatus == nil }

  init(node: URL, entry: URL) {
    self.node = node
    self.entry = entry
  }

  func start() throws {
    var sockets: [Int32] = [-1, -1]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0 else { throw posixError("socketpair") }
    var errPipe: [Int32] = [-1, -1]
    guard pipe(&errPipe) == 0 else {
      close(sockets[0])
      close(sockets[1])
      throw posixError("pipe")
    }
    defer {
      // The child's ends. It holds its own copies now, and the channel only
      // reads EOF once every copy of the far end is gone -- including this one.
      close(sockets[1])
      close(errPipe[1])
    }

    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    // Everything Node prints is also in its log file, which tray mode opens
    // before anything else can fail; stdout would only be a second copy.
    posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2)
    posix_spawn_file_actions_adddup2(&actions, sockets[1], 3)
    posix_spawn_file_actions_addchdir_np(&actions, entry.deletingLastPathComponent().deletingLastPathComponent().path)

    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    // CLOEXEC_DEFAULT: the child gets the four descriptors above and nothing
    // else of ours. SETPGROUP: its own process group, so whatever it leaves
    // running -- an ffmpeg encode, an osascript watcher -- can be stopped with
    // it. SETSIGDEF: this process ignores SIGTERM and SIGPIPE to handle them
    // itself, and an ignored signal stays ignored across exec unless reset.
    posix_spawnattr_setflags(
      &attributes,
      Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
    posix_spawnattr_setpgroup(&attributes, 0)
    var defaults = sigset_t()
    sigemptyset(&defaults)
    for signal in [SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGPIPE] { sigaddset(&defaults, signal) }
    posix_spawnattr_setsigdefault(&attributes, &defaults)
    var mask = sigset_t()
    sigemptyset(&mask)
    posix_spawnattr_setsigmask(&attributes, &mask)

    var environment = ProcessInfo.processInfo.environment
    // Launched from Finder or at login, PATH is the bare system one. The
    // bundled ffmpeg goes first so artwork never depends on what else is
    // installed; Homebrew's directories stay reachable for img2webp and for a
    // custom hosting.command.
    environment["PATH"] = [
      node.deletingLastPathComponent().path, "/opt/homebrew/bin", "/usr/local/bin",
      "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ].joined(separator: ":")
    environment["YANPRESENCE_MENU_FD"] = "3"

    let arguments = [node.path, entry.path, "--tray"]
    let variables = environment.map { "\($0.key)=\($0.value)" }

    var child: pid_t = 0
    let status = withCStrings(arguments) { argv in
      withCStrings(variables) { envp in
        posix_spawn(&child, node.path, &actions, &attributes, argv, envp)
      }
    }
    guard status == 0 else {
      close(sockets[0])
      close(errPipe[0])
      throw posixError("posix_spawn \(node.path)", code: status)
    }

    // Not inherited by anything else this process starts -- the xattr run
    // when moving to Applications, say -- which would hold the socket open
    // and keep Node from ever reading EOF if this process died.
    _ = fcntl(sockets[0], F_SETFD, FD_CLOEXEC)
    _ = fcntl(errPipe[0], F_SETFD, FD_CLOEXEC)

    pid = child
    startedAt = Date()
    exitStatus = nil
    reported = false
    watch(channel: sockets[0], stderr: errPipe[0])
    watchExit()
  }

  /// One line to Node. Lines are a few bytes and the socket buffers kilobytes,
  /// so a blocking write cannot hold up the menu.
  func send(_ line: String) {
    // Throws EPIPE once Node has gone; its exit is on the way, and that is
    // what acts.
    try? channel?.write(contentsOf: Data((line + "\n").utf8))
  }

  /// Signals Node and everything still in its process group.
  func signalGroup(_ signal: Int32) {
    guard pid > 0 else { return }
    kill(-pid, signal)
  }

  private func watch(channel descriptor: Int32, stderr: Int32) {
    let channel = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    channel.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      // At EOF the handler would otherwise be called again at once, forever.
      if data.isEmpty { handle.readabilityHandler = nil }
      DispatchQueue.main.async { MainActor.assumeIsolated { self?.received(data) } }
    }
    self.channel = channel

    let errors = FileHandle(fileDescriptor: stderr, closeOnDealloc: true)
    errors.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty { handle.readabilityHandler = nil }
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self else { return }
          self.stderrTail.append(data)
          if self.stderrTail.count > 8192 { self.stderrTail = self.stderrTail.suffix(4096) }
        }
      }
    }
    stderrReader = errors
  }

  private func received(_ data: Data) {
    guard !data.isEmpty else {
      closeChannel()
      // Node is gone, and everything it said before going has been read.
      if exitStatus != nil { report() }
      return
    }
    buffer.append(data)
    while let newline = buffer.firstIndex(of: 0x0A) {
      let line = buffer[buffer.startIndex..<newline]
      buffer.removeSubrange(buffer.startIndex...newline)
      // Anything that is not a JSON object is not a message; ignore it rather
      // than act on half of one.
      if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
        onMessage?(object)
      }
    }
  }

  private func closeChannel() {
    channel?.readabilityHandler = nil
    try? channel?.close()
    channel = nil
  }

  private func watchExit() {
    let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
    source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.reap() } }
    source.resume()
    exitSource = source
    // An exit before the source was armed would never be reported by it.
    reap()
  }

  private func reap() {
    guard pid > 0, exitStatus == nil else { return }
    var status: Int32 = 0
    guard waitpid(pid, &status, WNOHANG) == pid else { return }
    exitSource?.cancel()
    exitSource = nil
    // waitpid's status, decoded by hand: the W* macros are not imported.
    let signal = status & 0x7f
    exitStatus = signal == 0 ? ((status >> 8) & 0xff, nil) : (nil, signal)

    // The exit can be seen before the last of what Node wrote has been read,
    // and the last thing it writes is often the one that matters: why it
    // could not start. So the exit is reported once the channel has drained,
    // or after a second if something Node started is still holding it open.
    if channel == nil {
      report()
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { MainActor.assumeIsolated { self.report() } }
    }
  }

  private func report() {
    guard let exitStatus, !reported else { return }
    reported = true
    closeChannel()
    onExit?(exitStatus.code, exitStatus.signal)
  }
}

private func withCStrings<R>(_ strings: [String], _ body: ([UnsafeMutablePointer<CChar>?]) -> R) -> R {
  let pointers = strings.map { strdup($0) } + [nil]
  defer { pointers.forEach { free($0) } }
  return body(pointers)
}

private func posixError(_ what: String, code: Int32 = errno) -> NSError {
  NSError(domain: NSPOSIXErrorDomain, code: Int(code), userInfo: [
    NSLocalizedDescriptionKey: "\(what): \(String(cString: strerror(code)))",
  ])
}

// MARK: - The menu bar icon

/// The icon and its menu: everything the Windows tray icon has, plus the two
/// things a drag-installed Mac app has nowhere else to put -- whether it opens
/// at login, and which version it is.
@MainActor
final class MenuBar: NSObject, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private let status = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
  private let permission = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let artistPhoto = NSMenuItem(title: "Show Artist Photo", action: nil, keyEquivalent: "")
  private let openAtLogin = NSMenuItem(title: "Open at Login", action: nil, keyEquivalent: "")
  private let openLog = NSMenuItem(title: "Open Log", action: nil, keyEquivalent: "")

  var onArtistPhoto: ((Bool) -> Void)?
  private(set) var logFile: URL?

  override init() {
    super.init()

    item.button?.image = MenuBar.glyph()
    item.button?.toolTip = appName
    item.button?.setAccessibilityTitle(appName)

    menu.autoenablesItems = false
    menu.delegate = self

    let header = NSMenuItem(title: appName, action: nil, keyEquivalent: "")
    header.isEnabled = false
    menu.addItem(header)
    status.isEnabled = false
    menu.addItem(status)
    permission.target = self
    permission.action = #selector(openAutomationSettings)
    permission.isHidden = true
    menu.addItem(permission)
    menu.addItem(.separator())

    artistPhoto.target = self
    artistPhoto.action = #selector(toggleArtistPhoto)
    // Hidden until Node says where the switch stands: config.json and the
    // remembered choice are both its to read.
    artistPhoto.isHidden = true
    menu.addItem(artistPhoto)
    openAtLogin.target = self
    openAtLogin.action = #selector(toggleOpenAtLogin)
    menu.addItem(openAtLogin)
    menu.addItem(.separator())

    openLog.target = self
    openLog.action = #selector(showLog)
    openLog.isHidden = true
    menu.addItem(openLog)
    let about = NSMenuItem(title: "About \(appName)", action: #selector(showAbout), keyEquivalent: "")
    about.target = self
    menu.addItem(about)
    menu.addItem(.separator())
    // Through NSApp rather than straight to Node, so that a quit from here,
    // from logging out and from a second copy starting all take the same path.
    menu.addItem(NSMenuItem(title: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

    item.menu = menu
  }

  func hello(logFile: String?, artistPhoto on: Bool?) {
    if let logFile, !logFile.isEmpty {
      self.logFile = URL(fileURLWithPath: logFile)
      openLog.isHidden = false
    }
    if let on {
      artistPhoto.state = on ? .on : .off
      artistPhoto.isHidden = false
    } else {
      artistPhoto.isHidden = true
    }
  }

  /// What the icon says: `tooltip` on hover, `line` in the menu. Shortened
  /// here rather than by Node, which writes the same text for a Windows icon
  /// with its own limits.
  func setStatus(tooltip: String, line: String) {
    item.button?.toolTip = MenuBar.shorten(tooltip.isEmpty ? appName : tooltip, to: 120)
    status.title = MenuBar.shorten(line.isEmpty ? "Nothing playing" : line, to: 60)
  }

  /// Removed, not hidden: AppKit remembers `isVisible = false` across
  /// launches, and the icon would never come back.
  func hide() {
    NSStatusBar.system.removeStatusItem(item)
  }

  /// Drops the menu open, for someone who opened the app again to find it --
  /// putting the icon back first if it was hidden in System Settings, since
  /// opening the app is asking to see it.
  func popUp() {
    if !item.isVisible { item.isVisible = true }
    item.button?.performClick(nil)
  }

  // MARK: NSMenuDelegate

  func menuNeedsUpdate(_ menu: NSMenu) {
    // Read fresh every time: both can be changed in System Settings, behind
    // the app's back.
    switch SMAppService.mainApp.status {
    case .enabled: openAtLogin.state = .on
    default: openAtLogin.state = .off
    }

    let denied = [("Music", "com.apple.Music"), ("TV", "com.apple.TV")]
      .filter { MenuBar.automationDenied($0.1) }
      .map { $0.0 }
    permission.isHidden = denied.isEmpty
    permission.title = "Allow Control of \(denied.joined(separator: " and "))…"
  }

  // MARK: Actions

  @objc private func toggleArtistPhoto() {
    // Ticked at the click, so the menu answers at once; Node puts the change
    // on the card and remembers it for next time.
    artistPhoto.state = artistPhoto.state == .on ? .off : .on
    onArtistPhoto?(artistPhoto.state == .on)
  }

  @objc private func toggleOpenAtLogin() {
    let service = SMAppService.mainApp
    do {
      if service.status == .enabled {
        try service.unregister()
      } else {
        try service.register()
      }
    } catch {
      // Most often: switched off in System Settings, which is then the only
      // place it can be switched back on.
      if service.status == .requiresApproval {
        SMAppService.openSystemSettingsLoginItems()
      } else {
        Alerts.show(message: "Could not change Open at Login", detail: error.localizedDescription)
      }
    }
  }

  @objc private func showLog() {
    // Opened with whatever the user has for .log files -- Console, unless they
    // chose otherwise. Launched hidden at login there was no terminal to have
    // watched, so the log is the only account of what happened.
    guard let logFile, FileManager.default.fileExists(atPath: logFile.path) else { return }
    NSWorkspace.shared.open(logFile)
  }

  @objc private func openAutomationSettings() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") {
      NSWorkspace.shared.open(url)
    }
  }

  @objc private func showAbout() {
    Alerts.activate()
    let credits = NSAttributedString(
      string: "Apple Music and Apple TV presence for Discord.\nhttps://presence.ethanyanxu.com",
      attributes: [.font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)])
    NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
  }

  // MARK: Helpers

  /// Whether this app has been refused Automation access to a running app.
  ///
  /// Without this a "Don't Allow" -- one click, on a prompt that appears the
  /// first time Music plays -- leaves an app that silently never shows
  /// anything. Asks without prompting: a target that is not running, or has
  /// not been asked about yet, is not refused.
  static func automationDenied(_ bundleIdentifier: String) -> Bool {
    let target = NSAppleEventDescriptor(bundleIdentifier: bundleIdentifier)
    guard let address = target.aeDesc else { return false }
    return AEDeterminePermissionToAutomateTarget(address, typeWildCard, typeWildCard, false) == errAEEventNotPermitted
  }

  static func shorten(_ text: String, to limit: Int) -> String {
    text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
  }

  /// The beamed pair of notes from the app icon, as a template image so the
  /// menu bar can tint it for light and dark. Drawn rather than shipped, from
  /// the same 64-unit geometry as the website's logo.
  static func glyph() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      // The notes span x 14...53.2 and y 11.5...52.3 of the 64-unit box.
      let scale: CGFloat = 15.5 / 40.8
      context.translateBy(x: 9, y: 9)
      context.scaleBy(x: scale, y: scale)
      context.translateBy(x: -33.6, y: -31.9)
      NSColor.black.setFill()
      for bar in [
        NSRect(x: 28.4, y: 11.5, width: 24.8, height: 8.6),
        NSRect(x: 28.4, y: 15, width: 4.8, height: 30),
        NSRect(x: 48.4, y: 11.5, width: 4.8, height: 30),
      ] {
        NSBezierPath(roundedRect: bar, xRadius: 1.6, yRadius: 1.6).fill()
      }
      NSBezierPath(ovalIn: NSRect(x: 14, y: 37.3, width: 19.2, height: 15)).fill()
      NSBezierPath(ovalIn: NSRect(x: 34, y: 34.4, width: 19.2, height: 15)).fill()
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = appName
    return image
  }
}

/// NSApp.terminate, called from the run loop rather than from wherever this
/// is. Quitting waits in a nested run loop for Node to exit, and Node's exit
/// is reported on the main dispatch queue -- which a run loop nested inside
/// one of that queue's own blocks never drains. Called from a signal handler
/// or a process monitor directly, the app would wait forever.
@MainActor
func quitSoon() {
  NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0)
}

// MARK: - Alerts

@MainActor
enum Alerts {
  /// An accessory app has no Dock icon to be brought forward with, so a
  /// dialog it shows opens behind whatever is in front unless asked.
  static func activate() {
    if #available(macOS 14.0, *) {
      NSApp.activate()
    } else {
      NSApp.activate(ignoringOtherApps: true)
    }
  }

  /// A dialog that says what went wrong, with a way to the log when there is
  /// one. Only for things that stop the app: everything after start-up is the
  /// menu's to say.
  static func show(message: String, detail: String, logFile: URL? = nil, style: NSAlert.Style = .warning) {
    activate()
    let alert = NSAlert()
    alert.alertStyle = style
    alert.messageText = message
    alert.informativeText = detail
    alert.addButton(withTitle: "OK")
    if let logFile, FileManager.default.fileExists(atPath: logFile.path) {
      alert.addButton(withTitle: "Open Log")
    }
    if alert.runModal() == .alertSecondButtonReturn, let logFile {
      NSWorkspace.shared.open(logFile)
    }
  }
}

// MARK: - The app

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var menuBar: MenuBar?
  private var engine: Engine?
  private var signalSources: [DispatchSourceSignal] = []

  /// Read once at launch, to notice the bundle being replaced underneath us.
  private let runningVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""

  private var terminating = false
  private var saidHello = false
  private var fatalMessage: String?
  private var fatalLogFile: URL?
  private var quickFailures = 0
  private var restartTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Quitting has a presence to clear first, so SIGTERM -- from launchd at
    // logout, from `kill`, from a test -- goes through the same path as the
    // menu's Quit. SIGPIPE is ignored so a write to a Node that just died is
    // an error to shrug off, not the end of this process.
    signal(SIGPIPE, SIG_IGN)
    for signalNumber in [SIGTERM, SIGINT] {
      signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
      source.setEventHandler { MainActor.assumeIsolated { quitSoon() } }
      source.resume()
      signalSources.append(source)
    }

    takeOverFromOtherCopies { [weak self] in
      guard let self else { return }
      if Installation.offerMoveToApplications() { return }
      self.menuBar = MenuBar()
      self.menuBar?.onArtistPhoto = { [weak self] on in
        self?.engine?.send(on ? "artist-photo on" : "artist-photo off")
      }
      self.startEngine()
      Installation.applyOpenAtLoginDefault()
    }
  }

  /// Opened again while already running. Usually that is someone looking for
  /// an app with no window, so the menu drops open to show where it lives. If
  /// the copy on disk is a newer version than this one -- dragged over it from
  /// a new disk image -- that one is started instead, and takes over.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if Installation.versionOnDisk() != runningVersion {
      Installation.launchNewInstance(of: Bundle.main.bundleURL)
    } else {
      menuBar?.popUp()
    }
    return false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    restartTimer?.invalidate()
    guard let engine, engine.isRunning else { return .terminateNow }
    if terminating { return .terminateLater }
    terminating = true

    // Hidden at the click, so quitting feels immediate; Node has a presence to
    // clear with Discord before it goes, and exits on its own once it has.
    menuBar?.hide()
    engine.send("quit")
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, let engine = self.engine, engine.isRunning else { return }
        self.appendLog("WARN", "The app did not stop within 8s of being asked; stopping it")
        engine.signalGroup(SIGKILL)
      }
    }
    return .terminateLater
  }

  // MARK: Engine

  private func startEngine() {
    guard let resources = Bundle.main.resourceURL, let executables = Bundle.main.executableURL?.deletingLastPathComponent() else { return }
    let node = executables.appendingPathComponent("node")
    let entry = resources.appendingPathComponent("app/bin/yanpresence.js")
    guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: entry.path) else {
      Alerts.show(
        message: "\(appName) is incomplete",
        detail: "Its bundled runtime is missing. Download \(appName) again and replace this copy.",
        style: .critical)
      quitSoon()
      return
    }

    let engine = Engine(node: node, entry: entry)
    engine.onMessage = { [weak self] message in self?.received(message) }
    engine.onExit = { [weak self] code, signal in self?.engineExited(code: code, signal: signal) }
    self.engine = engine
    saidHello = false
    fatalMessage = nil

    do {
      try engine.start()
    } catch {
      Alerts.show(message: "\(appName) could not start", detail: error.localizedDescription, style: .critical)
      quitSoon()
    }
  }

  private func received(_ message: [String: Any]) {
    switch message["type"] as? String {
    case "hello":
      saidHello = true
      menuBar?.hello(logFile: message["logFile"] as? String, artistPhoto: message["artistPhoto"] as? Bool)
      engine?.send("ready")
    case "status":
      menuBar?.setStatus(tooltip: message["tooltip"] as? String ?? "", line: message["line"] as? String ?? "")
    case "fatal":
      fatalMessage = message["message"] as? String
      if let path = message["logFile"] as? String, !path.isEmpty { fatalLogFile = URL(fileURLWithPath: path) }
    default:
      break
    }
  }

  private func engineExited(code: Int32?, signal: Int32?) {
    // Whatever Node left behind in its group -- an encode mid-flight, a
    // watcher between polls -- goes with it. Quitting leaves nothing running.
    engine?.signalGroup(SIGTERM)
    let ranFor = Date().timeIntervalSince(engine?.startedAt ?? Date())
    let tail = engine.map { lastLines(of: $0.stderrTail) } ?? ""

    if terminating {
      NSApp.reply(toApplicationShouldTerminate: true)
      return
    }

    if let fatalMessage {
      Alerts.show(message: "\(appName) could not start", detail: fatalMessage, logFile: fatalLogFile ?? menuBar?.logFile, style: .critical)
      quitSoon()
      return
    }

    let how = signal.map { "signal \($0)" } ?? "code \(code ?? -1)"
    if code == 0 {
      // Node exits cleanly only when something asked it to: a SIGTERM from
      // Activity Monitor, say. That was a request to stop yanpresence.
      appendLog("INFO", "The app exited (\(how)); quitting")
      quitSoon()
      return
    }

    // A crash. One after a good long run is worth retrying, the way the
    // source install's launchd agent retries; one at start-up, or several in
    // a row, will only happen again.
    quickFailures = ranFor >= 60 ? 1 : quickFailures + 1
    if !saidHello || quickFailures > 5 {
      appendLog("ERROR", "The app exited (\(how)) and will not be restarted")
      Alerts.show(
        message: "\(appName) stopped unexpectedly",
        detail: tail.isEmpty ? "It exited with \(how)." : tail,
        logFile: menuBar?.logFile,
        style: .critical)
      quitSoon()
      return
    }

    let delay = pow(2.0, Double(quickFailures - 1))
    appendLog("WARN", "The app exited (\(how)); restarting it in \(Int(delay))s")
    menuBar?.setStatus(tooltip: "", line: "Restarting…")
    restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.startEngine() }
    }
  }

  // MARK: Other copies

  /// Two copies would fight over one presence, each overwriting the other's
  /// activity every few seconds. LaunchServices already sends a second open
  /// of the same app to the running one; what it allows is a second *copy* --
  /// one in Applications and one still on the disk image, say. The one being
  /// opened now wins: it is the one the user just asked for, and on an upgrade
  /// it is the new version. The others are asked to quit, which clears their
  /// presence, and only then does this one start.
  private func takeOverFromOtherCopies(then proceed: @escaping @MainActor () -> Void) {
    let me = ProcessInfo.processInfo.processIdentifier
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
      .map(\.processIdentifier)
      .filter { $0 != me }
    others.forEach { NSRunningApplication(processIdentifier: $0)?.terminate() }
    waitForExit(of: others, until: Date().addingTimeInterval(10), then: proceed)
  }

  /// Polls rather than observes: a copy that clears its presence and exits
  /// takes a second or two, and a copy that never answers has a deadline.
  private func waitForExit(of pids: [pid_t], until deadline: Date, then proceed: @escaping @MainActor () -> Void) {
    let alive = pids.compactMap { NSRunningApplication(processIdentifier: $0) }.filter { !$0.isTerminated }
    guard alive.isEmpty || Date() > deadline else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
        MainActor.assumeIsolated { self?.waitForExit(of: pids, until: deadline, then: proceed) }
      }
      return
    }
    alive.forEach { $0.forceTerminate() }
    proceed()
  }

  // MARK: Log

  /// A line in Node's log, in its format, for what only this process sees: the
  /// app exiting under it. Once Node has said where its log is; before that,
  /// a failure is shown rather than written.
  private func appendLog(_ level: String, _ message: String) {
    guard let logFile = menuBar?.logFile else { return }
    // O_APPEND, as Node opens it: two writers seeking to the end themselves
    // could each write over the other's last line.
    let descriptor = open(logFile.path, O_WRONLY | O_APPEND | O_CLOEXEC)
    guard descriptor >= 0 else { return }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    let stamp = DateFormatter()
    stamp.locale = Locale(identifier: "en_US_POSIX")
    stamp.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
    let line = "\(stamp.string(from: Date())) \(level.padding(toLength: 5, withPad: " ", startingAt: 0)) [menu bar] \(message)\n"
    try? handle.write(contentsOf: Data(line.utf8))
  }

  /// The end of Node's stderr, readable in a dialog: the last few lines, with
  /// the logger's timestamps taken off.
  private func lastLines(of data: Data) -> String {
    let text = String(decoding: data, as: UTF8.self)
    var lines: [String] = []
    for line in text.split(separator: "\n") {
      let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: false)
      let stamped = parts.count == 4 && parts[0].count == 10 && parts[1].count == 12
      lines.append(String(stamped ? parts[3] : line))
    }
    return lines.suffix(6).joined(separator: "\n")
  }
}

// MARK: - Where the app lives

/// The drag-installed half of what the Windows installer does: getting the app
/// into Applications, and starting it at login by default.
@MainActor
enum Installation {
  static var bundleURL: URL { Bundle.main.bundleURL }

  /// Running straight off the disk image, or from the read-only copy macOS
  /// makes of a quarantined app that was opened where it was downloaded.
  static var isOnDiskImage: Bool {
    let path = bundleURL.path
    if path.contains("/AppTranslocation/") { return true }
    let readOnly = (try? bundleURL.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly) ?? false
    return readOnly && path.hasPrefix("/Volumes/")
  }

  static var isInApplications: Bool {
    let path = bundleURL.path
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return !isOnDiskImage && (path.hasPrefix("/Applications/") || path.hasPrefix(home + "/Applications/"))
  }

  /// On the disk image the app would vanish at eject and could not open at
  /// login, so offer to put it in Applications -- the drag the disk image is
  /// laid out for, done for anyone who opened it in place instead. Returns
  /// true when the copy has been launched and this one should go no further.
  static func offerMoveToApplications() -> Bool {
    guard isOnDiskImage else { return false }
    Alerts.activate()
    let alert = NSAlert()
    alert.messageText = "Move \(appName) to Applications?"
    alert.informativeText = "\(appName) is running from the disk image. In the Applications folder it keeps running after you eject the disk image, and it can open when you log in."
    alert.addButton(withTitle: "Move to Applications")
    alert.addButton(withTitle: "Not Now")
    guard alert.runModal() == .alertFirstButtonReturn else { return false }

    let files = FileManager.default
    let system = URL(fileURLWithPath: "/Applications", isDirectory: true)
    let folder = files.isWritableFile(atPath: system.path)
      ? system
      : files.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true)
    let destination = folder.appendingPathComponent(bundleURL.lastPathComponent)
    do {
      try files.createDirectory(at: folder, withIntermediateDirectories: true)
      // An older copy goes to the Trash rather than away for good.
      if files.fileExists(atPath: destination.path) { try files.trashItem(at: destination, resultingItemURL: nil) }
      try files.copyItem(at: bundleURL, to: destination)
    } catch {
      Alerts.show(message: "Could not move \(appName)", detail: "\(error.localizedDescription)\n\nDrag it into the Applications folder instead.")
      return false
    }
    // The copy is of an app already opened past Gatekeeper. Left quarantined
    // it would be moved to a read-only location again on launch, which is the
    // thing this exists to avoid.
    let xattr = Process()
    xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
    xattr.arguments = ["-dr", "com.apple.quarantine", destination.path]
    try? xattr.run()
    xattr.waitUntilExit()

    launchNewInstance(of: destination, quitIfItFails: true)
    return true
  }

  /// Starts another copy, which takes over from this one (see
  /// takeOverFromOtherCopies) and so quits it.
  ///
  /// `quitIfItFails`: for a copy that has nothing else to do -- the one on the
  /// disk image, which never started its own icon -- and would otherwise be
  /// left running with nothing on screen.
  static func launchNewInstance(of url: URL, quitIfItFails: Bool = false) {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
      guard let error else { return }
      let detail = error.localizedDescription
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          Alerts.show(message: "Could not open \(appName)", detail: detail)
          if quitIfItFails { quitSoon() }
        }
      }
    }
  }

  /// The version in the bundle on disk now, which is not the one running if
  /// the bundle was replaced while it ran.
  static func versionOnDisk() -> String? {
    let plist = bundleURL.appendingPathComponent("Contents/Info.plist")
    return (NSDictionary(contentsOf: plist)?["CFBundleVersion"]) as? String
  }

  /// Open at Login, on by default as the Windows installer's startup box is.
  /// Applied once, the first time the app runs from Applications -- not from
  /// a build folder or the disk image, where a login item would point at
  /// something about to move -- and never again, so switching it off sticks.
  static func applyOpenAtLoginDefault() {
    let key = "OpenAtLoginDefaultApplied"
    guard isInApplications, !UserDefaults.standard.bool(forKey: key) else { return }
    UserDefaults.standard.set(true, forKey: key)
    if SMAppService.mainApp.status != .enabled { try? SMAppService.mainApp.register() }
  }
}

// MARK: - main

MainActor.assumeIsolated {
  let application = NSApplication.shared
  // NSApplication holds its delegate weakly; this one lives as long as run().
  let delegate = AppDelegate()
  application.delegate = delegate
  application.setActivationPolicy(.accessory)
  application.run()
}
