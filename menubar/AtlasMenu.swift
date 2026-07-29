// Project Atlas menu bar app.
//
// A native NSStatusItem: shows server state, opens the dashboard, triggers
// rescans, mirrors the view configuration (so the page can run map-only),
// and can stop/start the server's LaunchAgent.
//
// Build: swiftc -O AtlasMenu.swift -o AtlasMenu   (done by scripts/install.sh)

import AppKit
import Foundation

let BASE = "http://127.0.0.1:4317"
let SERVER_AGENT = "com.mickdarling.project-atlas"

// MARK: - Tiny synchronous HTTP (menus build in the blink before display;
// 400 ms is plenty for localhost and short enough to never feel stuck).

func httpJSON(_ path: String, method: String = "GET", body: [String: Any]? = nil,
              timeout: TimeInterval = 0.4) -> [String: Any]? {
    guard let url = URL(string: BASE + path) else { return nil }
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.httpMethod = method
    if let body = body {
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let sem = DispatchSemaphore(value: 0)
    var result: [String: Any]?
    URLSession.shared.dataTask(with: req) { data, _, _ in
        if let d = data {
            result = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + timeout + 0.1)
    return result
}

func setPref(_ key: String, _ value: String) {
    _ = httpJSON("/api/prefs", method: "POST", body: [key: value])
}

func launchctl(_ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = args
    try? p.run()
    p.waitUntilExit()
}

// MARK: - Option vocabulary (mirrors the page's controls)

struct Opt { let value: String; let label: String }

let GROUPS = [
    Opt(value: "owner", label: "Organization"),
    Opt(value: "provenance", label: "Provenance"),
    Opt(value: "status", label: "Status"),
    Opt(value: "presence", label: "Local vs Remote"),
    Opt(value: "language", label: "Language"),
    Opt(value: "visibility", label: "Hidden / Ignored"),
    Opt(value: "none", label: "Nothing (One Big Map)"),
]
let COLORS = [
    Opt(value: "recency", label: "Recency of Work"),
    Opt(value: "prov-recency", label: "Mine vs Outside × Recency"),
    Opt(value: "issues", label: "Open Issues"),
    Opt(value: "status", label: "Status"),
    Opt(value: "provenance", label: "Provenance"),
    Opt(value: "priority", label: "Priority"),
]
let SIZES = [
    Opt(value: "sqrt-effort", label: "√ Commits by Me"),
    Opt(value: "sqrt-commits", label: "√ All Commits"),
    Opt(value: "commits", label: "All Commits (Linear)"),
    Opt(value: "sqrt-issues", label: "√ Open Issues"),
    Opt(value: "issues", label: "Open Issues (Linear)"),
    Opt(value: "sqrt-files", label: "√ Tracked Files"),
    Opt(value: "equal", label: "Equal"),
]
let PALETTES = [
    Opt(value: "red:aqua", label: "Red → Aqua"),
    Opt(value: "red:green", label: "Red → Green"),
    Opt(value: "red:blue", label: "Red → Blue"),
    Opt(value: "yellow:violet", label: "Amber → Violet"),
    Opt(value: "orange:blue", label: "Orange → Blue"),
    Opt(value: "blue:blue", label: "Blue (Single Hue)"),
    Opt(value: "grey:grey", label: "Grey (Single Hue)"),
]
let SCALES = [
    Opt(value: "auto", label: "Auto — Spread This Set"),
    Opt(value: "fixed", label: "Fixed — Absolute Age"),
]
let SHOWING = [
    Opt(value: "visible", label: "Visible Only"),
    Opt(value: "all", label: "Everything"),
    Opt(value: "parked", label: "Only Hidden + Ignored"),
    Opt(value: "hidden", label: "Only Hidden"),
    Opt(value: "ignored", label: "Only Ignored"),
]
let THEMES = [
    Opt(value: "dark", label: "Dark"),
    Opt(value: "light", label: "Light"),
]

// MARK: - App

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var item: NSStatusItem!
    let menu = NSMenu()

    func applicationDidFinishLaunching(_ n: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = NSImage(systemSymbolName: "square.grid.2x2",
                             accessibilityDescription: "Project Atlas") {
            img.isTemplate = true
            item.button?.image = img
        } else {
            item.button?.title = "⊞"
        }
        menu.delegate = self
        item.menu = menu
    }

    // Rebuilt every time it opens, so checkmarks reflect reality, not memory.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let status = httpJSON("/api/status")
        let up = status?["up"] as? Bool ?? false
        let prefs = status?["prefs"] as? [String: Any] ?? [:]
        let scanning = status?["scanning"] as? Bool ?? false

        // --- status line ---
        let head = NSMenuItem()
        if up, let counts = status?["counts"] as? [String: Any] {
            let total = counts["total"] as? Int ?? 0
            let issues = counts["openIssues"] as? Int ?? 0
            head.title = "\(total) projects · \(issues) open issues"
        } else if up {
            head.title = "Server up — no inventory yet"
        } else {
            head.title = "Server not running"
        }
        head.isEnabled = false
        menu.addItem(head)
        menu.addItem(.separator())

        // --- actions ---
        menu.addItem(makeItem("Open Dashboard", #selector(openDashboard), "o", enabled: up))
        let scan = makeItem(scanning ? "Scanning…" : "Rescan Now",
                            #selector(rescan), "r", enabled: up && !scanning)
        menu.addItem(scan)
        menu.addItem(.separator())

        if up {
            // --- view configuration ---
            let mapOnly = makeItem("Map Only (Hide Controls)", #selector(toggleChrome), "m")
            mapOnly.state = (prefs["chrome"] as? String == "map") ? .on : .off
            menu.addItem(mapOnly)

            addSubmenu("Group By", GROUPS, prefKey: "group", current: prefs["group"] as? String ?? "owner")
            addSubmenu("Color By", COLORS, prefKey: "color", current: prefs["color"] as? String ?? "recency")
            addSubmenu("Area", SIZES, prefKey: "size", current: prefs["size"] as? String ?? "sqrt-effort")
            let curPalette = "\(prefs["hue"] as? String ?? "red"):\(prefs["hueTo"] as? String ?? "aqua")"
            addSubmenu("Palette", PALETTES, prefKey: "__palette", current: curPalette)
            addSubmenu("Scale", SCALES, prefKey: "scale", current: prefs["scale"] as? String ?? "auto")
            addSubmenu("Showing", SHOWING, prefKey: "visibility", current: prefs["visibility"] as? String ?? "visible")
            addSubmenu("Theme", THEMES, prefKey: "theme", current: prefs["theme"] as? String ?? "dark")
            menu.addItem(.separator())
        }

        // --- lifecycle ---
        if up {
            menu.addItem(makeItem("Stop Server", #selector(stopServer), ""))
        } else {
            menu.addItem(makeItem("Start Server", #selector(startServer), ""))
        }
        menu.addItem(makeItem("Quit Atlas Menu", #selector(quitApp), "q"))
    }

    func makeItem(_ title: String, _ sel: Selector, _ key: String, enabled: Bool = true) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: enabled ? sel : nil, keyEquivalent: key)
        it.target = self
        return it
    }

    func addSubmenu(_ title: String, _ opts: [Opt], prefKey: String, current: String) {
        let root = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu(title: title)
        for o in opts {
            let it = NSMenuItem(title: o.label, action: #selector(pickOption(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = [prefKey, o.value]
            it.state = (o.value == current) ? .on : .off
            sub.addItem(it)
        }
        root.submenu = sub
        menu.addItem(root)
    }

    // MARK: actions

    @objc func openDashboard() {
        NSWorkspace.shared.open(URL(string: BASE)!)
    }

    @objc func rescan() {
        _ = httpJSON("/api/scan", method: "POST", body: [:], timeout: 1.0)
    }

    @objc func toggleChrome() {
        let prefs = httpJSON("/api/prefs") ?? [:]
        let now = prefs["chrome"] as? String ?? "full"
        setPref("chrome", now == "map" ? "full" : "map")
    }

    @objc func pickOption(_ sender: NSMenuItem) {
        guard let pair = sender.representedObject as? [String], pair.count == 2 else { return }
        if pair[0] == "__palette" {
            let parts = pair[1].split(separator: ":").map(String.init)
            if parts.count == 2 {
                _ = httpJSON("/api/prefs", method: "POST",
                             body: ["hue": parts[0], "hueTo": parts[1]])
            }
        } else {
            setPref(pair[0], pair[1])
        }
    }

    @objc func stopServer() {
        // KeepAlive would resurrect a killed process; bootout is the real stop.
        launchctl(["bootout", "gui/\(getuid())/\(SERVER_AGENT)"])
    }

    @objc func startServer() {
        let plist = NSString(string: "~/Library/LaunchAgents/\(SERVER_AGENT).plist").expandingTildeInPath
        launchctl(["bootstrap", "gui/\(getuid())", plist])
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
let delegate = AppDelegate()
app.delegate = delegate
app.run()
