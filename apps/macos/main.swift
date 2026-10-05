import AppKit
import Foundation

struct MenuConfiguration: Decodable {
    let port: Int
    let instanceID: String
    let servicePlist: String
}

final class MenuBarDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: RoutingStatus.checking.title, action: nil, keyEquivalent: "")
    private let detailLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var startItem: NSMenuItem!
    private var restartItem: NSMenuItem!
    private var stopItem: NSMenuItem!
    private var quitItem: NSMenuItem!
    private var timer: Timer?
    private var request: URLSessionDataTask?
    private var busy = false
    private var statusGeneration = 0
    private var currentStatus = RoutingStatus.checking
    private let configuration: MenuConfiguration
    private let domain = "gui/\(getuid())"
    private let label = "com.route2.codex"
    private let worker = DispatchQueue(label: "com.route2.menubar.controls")

    init(configuration: MenuConfiguration) {
        self.configuration = configuration
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = octopusIcon()
        statusItem.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.autoenablesItems = false
        statusLine.isEnabled = false
        detailLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(detailLine)
        menu.addItem(.separator())
        startItem = addItem("Start Route2", action: #selector(startService), to: menu)
        restartItem = addItem("Restart Route2", action: #selector(restartService), to: menu)
        stopItem = addItem("Stop Route2", action: #selector(stopService), to: menu)
        menu.addItem(.separator())
        _ = addItem("Open Status…", action: #selector(openStatus), to: menu)
        menu.addItem(.separator())
        quitItem = addItem("Quit Route2", action: #selector(quit), to: menu)
        statusItem.menu = menu
        render(.checking)
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        request?.cancel()
    }

    private func addItem(_ title: String, action: Selector, to menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        return item
    }

    private func render(_ status: RoutingStatus, detail: String = "") {
        currentStatus = status
        statusLine.title = status.title
        detailLine.title = detail
        detailLine.isHidden = detail.isEmpty
        statusItem.button?.title = " \(status.symbol)"
        statusItem.button?.toolTip = status.title
        statusItem.button?.setAccessibilityLabel(status.title)
        startItem.isEnabled = !busy && (status == .stopped || status == .unavailable)
        restartItem.isEnabled = !busy && status != .wrongService && status != .checking
        stopItem.isEnabled = !busy && status != .stopped && status != .wrongService && status != .checking
        quitItem.isEnabled = !busy
    }

    private func refresh() {
        guard request == nil, !busy else { return }
        statusGeneration += 1
        let generation = statusGeneration
        var healthRequest = URLRequest(url: URL(string: "http://127.0.0.1:\(configuration.port)/health")!)
        healthRequest.timeoutInterval = 2
        healthRequest.cachePolicy = .reloadIgnoringLocalCacheData
        request = URLSession.shared.dataTask(with: healthRequest) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard generation == self.statusGeneration else { return }
                self.request = nil
                guard !self.busy else { return }
                guard error == nil, let data, data.count <= 8192,
                      let response = response as? HTTPURLResponse, response.statusCode == 200,
                      let health = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    self.worker.async {
                        let loaded = (try? self.launchctl(["print", "\(self.domain)/\(self.label)"])) == 0
                        DispatchQueue.main.async {
                            guard !self.busy, generation == self.statusGeneration else { return }
                            self.render(loaded ? .unavailable : .stopped)
                        }
                    }
                    return
                }
                let status = RoutingStatus.from(health: health, instanceID: self.configuration.instanceID)
                let classifier = health["classifier"] as? [String: Any]
                let elapsed = (classifier?["elapsed_ms"] as? Double).map { " · \(Int($0 / 1000))s" } ?? ""
                self.render(status, detail: status == .loading ? "Warming up\(elapsed); prompts use fallback" : "")
            }
        }
        request?.resume()
    }

    @objc private func startService() { perform(.start) }
    @objc private func restartService() { perform(.restart) }
    @objc private func stopService() { perform(.stop) }
    @objc private func openStatus() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(configuration.port)/status")!)
    }
    @objc private func quit() { perform(.stop, quitAfterStop: true) }

    private func perform(_ action: ServiceAction, quitAfterStop: Bool = false) {
        guard !busy, currentStatus != .wrongService || quitAfterStop else { return }
        busy = true
        statusGeneration += 1
        request?.cancel()
        request = nil
        render(currentStatus, detail: action == .stop ? "Stopping Route2…" : "Starting Route2…")
        worker.async { [weak self] in
            guard let self else { return }
            do {
                let loaded = try self.launchctl(["print", "\(self.domain)/\(self.label)"]) == 0
                for command in action.commands(domain: self.domain, label: self.label,
                                               plist: self.configuration.servicePlist, loaded: loaded) {
                    guard try self.launchctl(command) == 0 else {
                        throw NSError(domain: "Route2", code: 1,
                                      userInfo: [NSLocalizedDescriptionKey: "Could not \(action.rawValue) the Route2 login service."])
                    }
                }
                DispatchQueue.main.async {
                    self.busy = false
                    if quitAfterStop {
                        NSApplication.shared.terminate(nil)
                        return
                    }
                    self.render(action == .stop ? .stopped : .loading)
                    self.refresh()
                }
            } catch {
                DispatchQueue.main.async {
                    self.busy = false
                    self.render(self.currentStatus, detail: "Control failed; check the service installation")
                    let alert = NSAlert()
                    alert.messageText = "Route2 could not \(action.rawValue)"
                    alert.informativeText = "Check that Route2 is installed for this macOS user. No Codex settings were changed."
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    alert.runModal()
                }
            }
        }
    }

    private func launchctl(_ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = Date().addingTimeInterval(10)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isRunning {
            process.terminate()
            throw NSError(domain: "Route2", code: 2)
        }
        return process.terminationStatus
    }

    private func octopusIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: 5, y: 6, width: 10, height: 11)).fill()
            NSColor.black.setStroke()
            for index in 0..<4 {
                let offset = CGFloat(index) * 2
                for side: CGFloat in [-1, 1] {
                    let tentacle = NSBezierPath()
                    tentacle.lineWidth = 1.7
                    tentacle.lineCapStyle = .round
                    tentacle.move(to: NSPoint(x: 10 + side * (1 + offset / 2), y: 8))
                    tentacle.curve(to: NSPoint(x: 10 + side * (2 + offset), y: 2 + offset / 2),
                                   controlPoint1: NSPoint(x: 10 + side * (3 + offset), y: 7 - offset / 2),
                                   controlPoint2: NSPoint(x: 10 + side * offset, y: -1))
                    tentacle.stroke()
                }
            }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current?.compositingOperation = .destinationOut
            NSColor.white.setFill()
            for eye in [8, 12] {
                NSBezierPath(ovalIn: NSRect(x: CGFloat(eye), y: 11, width: 1.5, height: 2)).fill()
            }
            NSGraphicsContext.restoreGraphicsState()
            return true
        }
        image.isTemplate = true
        return image
    }
}

let runningInstances = NSRunningApplication.runningApplications(withBundleIdentifier: "com.route2.menubar")
    .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
guard runningInstances.isEmpty else { exit(0) }

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
guard let configURL = Bundle.main.url(forResource: "configuration", withExtension: "json"),
      let configData = try? Data(contentsOf: configURL),
      let configuration = try? JSONDecoder().decode(MenuConfiguration.self, from: configData),
      (1...65535).contains(configuration.port), !configuration.instanceID.isEmpty else {
    fputs("Route2 menu bar: missing or invalid installation configuration\n", stderr)
    exit(2)
}
let delegate = MenuBarDelegate(configuration: configuration)
application.delegate = delegate
application.run()
