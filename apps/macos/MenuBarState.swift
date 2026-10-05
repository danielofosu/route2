import Foundation

enum RoutingStatus: Equatable {
    case checking, stopped, unavailable, loading, ready, degraded, running, wrongService

    static func from(health: [String: Any], instanceID: String) -> RoutingStatus {
        guard health["service"] as? String == "route2",
              health["instanceId"] as? String == instanceID else { return .wrongService }
        guard let classifier = health["classifier"] as? [String: Any],
              let state = classifier["state"] as? String else { return .running }
        switch state {
        case "ready": return .ready
        case "starting", "loading": return .loading
        case "error", "failed", "stopped", "unavailable": return .degraded
        default: return .loading
        }
    }

    var title: String {
        switch self {
        case .checking: return "Route2 — Checking…"
        case .stopped: return "Route2 — Stopped"
        case .unavailable: return "Route2 — Service not responding"
        case .loading: return "Route2 — Loading classifier…"
        case .ready: return "Route2 — Ready"
        case .degraded: return "Route2 — Fallback routing"
        case .running: return "Route2 — Running (legacy status)"
        case .wrongService: return "Route2 — Different service on port"
        }
    }

    var symbol: String {
        switch self {
        case .ready: return "●"
        case .running: return "●"
        case .checking, .loading: return "◐"
        case .degraded, .wrongService, .unavailable: return "!"
        case .stopped: return "○"
        }
    }
}

enum ServiceAction: String {
    case start, restart, stop

    func commands(domain: String, label: String, plist: String, loaded: Bool) -> [[String]] {
        let target = "\(domain)/\(label)"
        switch self {
        case .stop:
            return [["disable", target]] + (loaded ? [["bootout", target]] : [])
        case .start, .restart:
            let activate = loaded
                ? (self == .restart ? ["kickstart", "-k", target] : ["kickstart", target])
                : ["bootstrap", domain, plist]
            return [["enable", target], activate]
        }
    }
}
