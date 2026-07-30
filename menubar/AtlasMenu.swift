// Project Atlas menu bar app.
//
// A status item that opens a CONTROL PANEL, not a throwaway menu: change as
// many settings as you like — it stays open. It closes when the mouse leaves
// it (short grace period), or on Esc / click-away.
//
// Build: swiftc -O AtlasMenu.swift -o AtlasMenu   (done by scripts/install.sh)

import AppKit
import Foundation

let BASE = "http://127.0.0.1:4317"
let SERVER_AGENT = "com.mickdarling.project-atlas"

// MARK: - HTTP helpers

func httpJSON(_ path: String, method: String = "GET", body: [String: Any]? = nil,
              timeout: TimeInterval = 0.6,
              done: (([String: Any]?) -> Void)? = nil) {
    guard let url = URL(string: BASE + path) else { done?(nil); return }
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.httpMethod = method
    if let body = body {
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    URLSession.shared.dataTask(with: req) { data, _, _ in
        let obj = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        DispatchQueue.main.async { done?(obj) }
    }.resume()
}

// MARK: - Time helpers

let isoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
let isoPlain = ISO8601DateFormatter()

func parseISO(_ s: String) -> Date? {
    isoFrac.date(from: s) ?? isoPlain.date(from: s)
}

func agoString(_ d: Date) -> String {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f.localizedString(for: d, relativeTo: Date())
}

// A scan runs daily; if the inventory is older than this, something is wrong
// and the icon should say so without the panel being opened.
let STALE_AFTER: TimeInterval = 24 * 3600

func launchctl(_ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = args
    try? p.run()
    p.waitUntilExit()
}

// MARK: - Option vocabulary (mirrors the page's controls)

struct Opt {
    let value: String
    let label: String
    var tip: String? = nil
}

let SECTIONS: [(key: String, title: String, opts: [Opt])] = [
    ("group", "Group by", [
        Opt(value: "owner", label: "Organization"),
        Opt(value: "provenance", label: "Provenance"),
        Opt(value: "status", label: "Status"),
        Opt(value: "presence", label: "Local vs remote"),
        Opt(value: "language", label: "Language"),
        Opt(value: "visibility", label: "Hidden / ignored"),
        Opt(value: "duplicates", label: "Duplicate clusters"),
        Opt(value: "none", label: "Nothing (one big map)"),
    ]),
    ("color", "Color by", [
        Opt(value: "recency", label: "Recency of work",
            tip: "How recently the last commit or push happened. Darker/higher = fresher."),
        Opt(value: "prov-recency", label: "Mine vs outside × recency",
            tip: "Hue = whose project it is (blue mine, amber a fork, green someone else's clone); lightness = how recently touched."),
        Opt(value: "issues", label: "Open issues",
            tip: "Open GitHub issue count, binned none → 100+."),
        Opt(value: "status", label: "Status",
            tip: "Your own triage call (active / in use / someday / done / dead). Untriaged repos stay grey."),
        Opt(value: "provenance", label: "Provenance",
            tip: "Mine vs fork vs clone of someone else's — detected, with your overrides."),
        Opt(value: "priority", label: "Priority",
            tip: "Your own high / medium / low marks. Unset stays grey."),
    ]),
    ("size", "Area", [
        Opt(value: "sqrt-work", label: "√ work by me (commits + lines)",
            tip: "Tile area ∝ √(your commits + your changed lines ÷ 100). Both kinds of work count: seven tiny edits and one 3,000-line commit are both real sessions."),
        Opt(value: "sqrt-effort", label: "√ commits by me",
            tip: "Tile area ∝ √(commits YOU authored, counted across every branch). Your investment: forks and clones of other people's work shrink to nothing. √ compresses the range so small projects stay visible."),
        Opt(value: "sqrt-commits", label: "√ all commits",
            tip: "Tile area ∝ √(every commit in the repo, all branches, whoever wrote them). A big fork looks big even though the work isn't yours."),
        Opt(value: "commits", label: "All commits (linear)",
            tip: "Area is exactly proportional to total commits — the unflattering truth. Big repos dominate and small ones may not get a pixel."),
        Opt(value: "sqrt-issues", label: "√ open issues",
            tip: "Tile area ∝ √(open GitHub issues). If issues are where your ideas land, this is the idea map."),
        Opt(value: "issues", label: "Open issues (linear)",
            tip: "Area exactly proportional to open issues. mcp-server's 860 will dwarf everything."),
        Opt(value: "sqrt-files", label: "√ tracked files",
            tip: "Tile area ∝ √(files under git). How much thing is there, regardless of who built it."),
        Opt(value: "equal", label: "Equal",
            tip: "Every project gets the same tile. Pure census — size carries no meaning."),
    ]),
    ("accent", "Accent by", [
        Opt(value: "off", label: "Off",
            tip: "No second channel — one variable per tile."),
        Opt(value: "recency", label: "Recency of work",
            tip: "A top-edge tab strip carrying a second validated ramp."),
        Opt(value: "issues", label: "Open issues"),
        Opt(value: "status", label: "Status"),
        Opt(value: "priority", label: "Priority"),
        Opt(value: "provenance", label: "Provenance"),
        Opt(value: "research", label: "Research flag",
            tip: "Tab on repos whose topics or tags say research / paper / results / findings."),
    ]),
    ("__palette", "Palette", [
        Opt(value: "red:aqua", label: "Red → Aqua"),
        Opt(value: "red:green", label: "Red → Green"),
        Opt(value: "red:blue", label: "Red → Blue"),
        Opt(value: "yellow:violet", label: "Amber → Violet"),
        Opt(value: "orange:blue", label: "Orange → Blue"),
        Opt(value: "blue:blue", label: "Blue (single hue)"),
        Opt(value: "grey:grey", label: "Grey (single hue)"),
    ]),
    ("scale", "Scale", [
        Opt(value: "auto", label: "Auto — spread this set"),
        Opt(value: "fixed", label: "Fixed — absolute age"),
    ]),
    ("date", "Worked on", [
        Opt(value: "any", label: "Any time"),
        Opt(value: "week", label: "Past week"),
        Opt(value: "month", label: "Past 30 days"),
        Opt(value: "quarter", label: "Past 90 days"),
        Opt(value: "year", label: "Past year"),
        Opt(value: "quiet-year", label: "Quiet 1 year +"),
        Opt(value: "quiet-2y", label: "Quiet 2 years +"),
    ]),
    ("visibility", "Showing", [
        Opt(value: "visible", label: "Visible only"),
        Opt(value: "all", label: "Everything"),
        Opt(value: "parked", label: "Only hidden + ignored"),
        Opt(value: "hidden", label: "Only hidden"),
        Opt(value: "ignored", label: "Only ignored"),
    ]),
    ("theme", "Theme", [
        Opt(value: "dark", label: "Dark"),
        Opt(value: "light", label: "Light"),
    ]),
]

// MARK: - The panel

final class PanelController: NSViewController, NSMenuDelegate {
    weak var owner: AppDelegate?

    let statusLabel = NSTextField(labelWithString: "…")
    var popups: [String: NSPopUpButton] = [:]
    let mapOnly = NSButton(checkboxWithTitle: "Map only (hide page controls)", target: nil, action: nil)
    let shareMode = NSButton(checkboxWithTitle: "Share mode (hide private names)", target: nil, action: nil)
    let openBtn = NSButton(title: "Open Dashboard", target: nil, action: nil)
    let rescanBtn = NSButton(title: "Update Now", target: nil, action: nil)
    let serverBtn = NSButton(title: "Stop Server", target: nil, action: nil)
    let quitBtn = NSButton(title: "Quit", target: nil, action: nil)
    var serverUp = false

    override func loadView() {
        let grid = NSGridView(numberOfColumns: 2, rows: 0)
        grid.columnSpacing = 10
        grid.rowSpacing = 7
        grid.column(at: 0).xPlacement = .trailing

        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail

        openBtn.target = self; openBtn.action = #selector(openDashboard)
        rescanBtn.target = self; rescanBtn.action = #selector(rescan)
        serverBtn.target = self; serverBtn.action = #selector(toggleServer)
        quitBtn.target = self; quitBtn.action = #selector(quitApp)
        mapOnly.target = self; mapOnly.action = #selector(mapOnlyChanged)
        shareMode.target = self; shareMode.action = #selector(shareModeChanged)
        shareMode.toolTip = "Keep the shape, hide the identities: private repo and org names become stable pseudonyms; paths, descriptions, notes and tags are hidden. Numbers stay."
        for b in [openBtn, rescanBtn, serverBtn, quitBtn] {
            b.bezelStyle = .rounded
            b.controlSize = .small
            b.font = .systemFont(ofSize: 11)
        }
        mapOnly.font = .systemFont(ofSize: 12)
        shareMode.font = .systemFont(ofSize: 12)

        let actions = NSStackView(views: [openBtn, rescanBtn])
        actions.spacing = 6

        grid.addRow(with: [NSGridCell.emptyContentView, statusLabel])
        grid.addRow(with: [NSGridCell.emptyContentView, actions])
        addSeparator(grid)

        for section in SECTIONS {
            let label = NSTextField(labelWithString: section.title)
            label.font = .systemFont(ofSize: 12)
            label.textColor = .labelColor

            let popup = NSPopUpButton(frame: .zero, pullsDown: false)
            popup.controlSize = .small
            popup.font = .systemFont(ofSize: 12)
            for o in section.opts {
                popup.addItem(withTitle: o.label)
                popup.lastItem?.toolTip = o.tip // hover an option to see what it means
            }
            popup.target = self
            popup.action = #selector(popupChanged(_:))
            popup.identifier = NSUserInterfaceItemIdentifier(section.key)
            // While a popup's own menu is open the cursor is outside the panel;
            // that must not count as "moved away".
            popup.menu?.delegate = self
            popups[section.key] = popup
            grid.addRow(with: [label, popup])
        }

        addSeparator(grid)
        grid.addRow(with: [NSGridCell.emptyContentView, mapOnly])
        grid.addRow(with: [NSGridCell.emptyContentView, shareMode])
        let lifecycle = NSStackView(views: [serverBtn, quitBtn])
        lifecycle.spacing = 6
        grid.addRow(with: [NSGridCell.emptyContentView, lifecycle])

        let wrap = NSView()
        wrap.addSubview(grid)
        grid.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: wrap.topAnchor, constant: 12),
            grid.bottomAnchor.constraint(equalTo: wrap.bottomAnchor, constant: -12),
            grid.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 14),
            grid.trailingAnchor.constraint(equalTo: wrap.trailingAnchor, constant: -14),
            wrap.widthAnchor.constraint(greaterThanOrEqualToConstant: 340),
        ])
        view = wrap
    }

    func addSeparator(_ grid: NSGridView) {
        let sep = NSBox()
        sep.boxType = .separator
        grid.addRow(with: [sep])
        grid.row(at: grid.numberOfRows - 1).mergeCells(in: NSRange(location: 0, length: 2))
    }

    // Pull truth from the server and reflect it. Called on open + every 2 s.
    func refresh() {
        httpJSON("/api/status") { [weak self] status in
            guard let self = self else { return }
            self.serverUp = status?["up"] as? Bool ?? false
            let prefs = status?["prefs"] as? [String: Any] ?? [:]
            let scanning = status?["scanning"] as? Bool ?? false

            // Mid-scan, say where it is, not just that it is running: the
            // scanner reports its phase and counts through /api/status.
            var busy = "Updating…"
            if scanning, let prog = status?["progress"] as? [String: Any],
               let phase = prog["phase"] as? String {
                let done = prog["done"] as? Int ?? 0
                let total = prog["total"] as? Int ?? 0
                busy = total > 0 ? "Updating… \(phase) \(done)/\(total)" : "Updating… \(phase)"
            }

            if self.serverUp, let counts = status?["counts"] as? [String: Any] {
                let total = counts["total"] as? Int ?? 0
                let issues = counts["openIssues"] as? Int ?? 0
                var line = "\(total) projects · \(issues) open issues"
                // The numbers mean nothing without "as of when".
                if let gen = status?["generatedAt"] as? String, let d = parseISO(gen) {
                    line += " · updated \(agoString(d))"
                }
                self.statusLabel.stringValue = scanning ? busy : line
            } else if self.serverUp && scanning {
                self.statusLabel.stringValue = busy
            } else {
                self.statusLabel.stringValue = self.serverUp ? "Server up — no inventory yet" : "Server not running"
            }

            self.rescanBtn.isEnabled = self.serverUp && !scanning
            self.rescanBtn.title = scanning ? "Updating…" : "Update Now"
            self.openBtn.isEnabled = self.serverUp
            self.mapOnly.isEnabled = self.serverUp
            self.serverBtn.title = self.serverUp ? "Stop Server" : "Start Server"

            for (key, popup) in self.popups {
                popup.isEnabled = self.serverUp
                let current = key == "__palette"
                    ? "\(prefs["hue"] as? String ?? "red"):\(prefs["hueTo"] as? String ?? "aqua")"
                    : (prefs[key] as? String ?? "")
                let opts = SECTIONS.first { $0.key == key }?.opts ?? []
                if let idx = opts.firstIndex(where: { $0.value == current }) {
                    popup.selectItem(at: idx)
                } else if !current.isEmpty {
                    popup.selectItem(at: -1)
                }
            }
            self.mapOnly.state = (prefs["chrome"] as? String == "map") ? .on : .off
            self.shareMode.isEnabled = self.serverUp
            self.shareMode.state = (prefs["share"] as? String == "on") ? .on : .off

            // While the panel is open it polls every 2 s — feed the icon from
            // the same answers so it tracks a running scan in real time.
            self.owner?.applyStatus(status)
        }
    }

    // MARK: actions — none of these close the panel except Open/Quit

    @objc func popupChanged(_ sender: NSPopUpButton) {
        guard let key = sender.identifier?.rawValue,
              let opts = SECTIONS.first(where: { $0.key == key })?.opts,
              sender.indexOfSelectedItem >= 0,
              sender.indexOfSelectedItem < opts.count else { return }
        let value = opts[sender.indexOfSelectedItem].value
        if key == "__palette" {
            let parts = value.split(separator: ":").map(String.init)
            if parts.count == 2 {
                httpJSON("/api/prefs", method: "POST", body: ["hue": parts[0], "hueTo": parts[1]])
            }
        } else {
            httpJSON("/api/prefs", method: "POST", body: [key: value])
        }
    }

    @objc func mapOnlyChanged() {
        httpJSON("/api/prefs", method: "POST",
                 body: ["chrome": mapOnly.state == .on ? "map" : "full"])
    }

    @objc func shareModeChanged() {
        httpJSON("/api/prefs", method: "POST",
                 body: ["share": shareMode.state == .on ? "on" : "off"])
    }

    @objc func openDashboard() {
        NSWorkspace.shared.open(URL(string: BASE)!)
        owner?.closePanel()
    }

    @objc func rescan() {
        rescanBtn.isEnabled = false
        rescanBtn.title = "Updating…"
        httpJSON("/api/scan", method: "POST", body: [:], timeout: 2.0)
    }

    @objc func toggleServer() {
        if serverUp {
            // KeepAlive would resurrect a killed process; bootout is the real stop.
            launchctl(["bootout", "gui/\(getuid())/\(SERVER_AGENT)"])
        } else {
            let plist = NSString(string: "~/Library/LaunchAgents/\(SERVER_AGENT).plist").expandingTildeInPath
            launchctl(["bootstrap", "gui/\(getuid())", plist])
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.refresh() }
    }

    @objc func quitApp() { NSApp.terminate(nil) }

    // MARK: popup-menu guard — an open dropdown pauses the mouse-away close

    func menuWillOpen(_ menu: NSMenu) { owner?.suspendAutoClose() }
    func menuDidClose(_ menu: NSMenu) { owner?.resumeAutoClose() }
}

// MARK: - App: status item + popover + mouse-away tracking

class AppDelegate: NSResponder, NSApplicationDelegate, NSPopoverDelegate {
    var item: NSStatusItem!
    let popover = NSPopover()
    let panel = PanelController()
    var exitTimer: Timer?
    var refreshTimer: Timer?
    var statusTimer: Timer?
    var suspendCount = 0
    var tracking: NSTrackingArea?

    // What the icon says at a glance, panel closed. Fresh is the quiet
    // default; every other state is the icon asking to be looked at.
    enum IconState { case fresh, scanning, stale, down }
    var iconState: IconState = .fresh

    func applicationDidFinishLaunching(_ n: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.target = self
        item.button?.action = #selector(togglePanel)
        setIcon(.fresh)

        panel.owner = self
        popover.contentViewController = panel
        popover.behavior = .transient // click-away / Esc still close it
        popover.animates = false // snap open/closed; the fade reads as lag
        popover.delegate = self

        // Slow background poll so the icon stays honest while the panel is
        // closed. The panel's own 2 s refresh takes over while it is open.
        statusTimer = Timer.scheduledTimer(withTimeInterval: 60.0, repeats: true) { [weak self] _ in
            self?.pollStatus()
        }
        pollStatus()
    }

    func pollStatus() {
        httpJSON("/api/status", timeout: 1.5) { [weak self] status in
            self?.applyStatus(status)
        }
    }

    func applyStatus(_ status: [String: Any]?) {
        let next: IconState
        if !(status?["up"] as? Bool ?? false) {
            next = .down
        } else if status?["scanning"] as? Bool ?? false {
            next = .scanning
        } else if let gen = status?["generatedAt"] as? String, let d = parseISO(gen) {
            next = Date().timeIntervalSince(d) > STALE_AFTER ? .stale : .fresh
        } else {
            next = .stale // up, but no inventory has ever been written
        }
        if next != iconState { setIcon(next) }
    }

    func setIcon(_ s: IconState) {
        iconState = s
        guard let button = item.button else { return }
        let (symbol, desc): (String, String)
        switch s {
        case .fresh: (symbol, desc) = ("square.grid.2x2", "Project Atlas")
        case .scanning: (symbol, desc) = ("arrow.triangle.2.circlepath", "Project Atlas — updating now")
        case .stale: (symbol, desc) = ("clock.badge.exclamationmark", "Project Atlas — data over a day old")
        case .down: (symbol, desc) = ("square.grid.2x2", "Project Atlas — server not running")
        }
        if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: desc) {
            img.isTemplate = true
            button.image = img
        } else {
            button.image = nil
            button.title = "⊞"
        }
        button.appearsDisabled = (s == .down)
        button.toolTip = desc
    }

    @objc func togglePanel() {
        if popover.isShown { closePanel(); return }
        guard let button = item.button else { return }
        panel.refresh()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)

        if let old = tracking { panel.view.removeTrackingArea(old) }
        let ta = NSTrackingArea(rect: .zero,
                                options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                owner: self, userInfo: nil)
        panel.view.addTrackingArea(ta)
        tracking = ta

        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.panel.refresh()
        }
    }

    func closePanel() { popover.performClose(nil) }

    func popoverDidClose(_ notification: Notification) {
        exitTimer?.invalidate()
        refreshTimer?.invalidate()
        suspendCount = 0
    }

    // The panel only disappears once the mouse has actually left it — with a
    // grace period, so grazing the edge doesn't dismiss your half-done config.
    override func mouseExited(with event: NSEvent) {
        guard popover.isShown else { return }
        exitTimer?.invalidate()
        exitTimer = Timer.scheduledTimer(withTimeInterval: 0.9, repeats: false) { [weak self] _ in
            guard let self = self, self.popover.isShown, self.suspendCount == 0 else { return }
            self.closePanel()
        }
    }

    override func mouseEntered(with event: NSEvent) {
        exitTimer?.invalidate()
    }

    func suspendAutoClose() {
        suspendCount += 1
        exitTimer?.invalidate()
    }

    func resumeAutoClose() {
        suspendCount = max(0, suspendCount - 1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
