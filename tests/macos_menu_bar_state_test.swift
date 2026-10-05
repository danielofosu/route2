import Foundation

@main
struct MenuBarStateTests {
    static func main() {
        let identity: [String: Any] = ["service": "route2", "instanceId": "owned"]
        for (phase, expected) in [("ready", RoutingStatus.ready), ("loading", .loading),
                                  ("starting", .loading), ("error", .degraded), ("stopped", .degraded)] {
            var health = identity
            health["classifier"] = ["state": phase]
            precondition(RoutingStatus.from(health: health, instanceID: "owned") == expected)
        }
        precondition(RoutingStatus.from(health: identity, instanceID: "owned") == .running)
        precondition(RoutingStatus.from(health: identity, instanceID: "different") == .wrongService)
        precondition(RoutingStatus.from(health: ["service": "other"], instanceID: "owned") == .wrongService)
        let target = "gui/501/com.route2.codex"
        let plist = "/Users/test user/Library/LaunchAgents/com.route2.codex.plist"
        precondition(ServiceAction.stop.commands(domain: "gui/501", label: "com.route2.codex",
                                                 plist: plist, loaded: true) == [["disable", target], ["bootout", target]])
        precondition(ServiceAction.stop.commands(domain: "gui/501", label: "com.route2.codex",
                                                 plist: plist, loaded: false) == [["disable", target]])
        precondition(ServiceAction.start.commands(domain: "gui/501", label: "com.route2.codex",
                                                  plist: plist, loaded: false) == [["enable", target], ["bootstrap", "gui/501", plist]])
        precondition(ServiceAction.start.commands(domain: "gui/501", label: "com.route2.codex",
                                                  plist: plist, loaded: true) == [["enable", target], ["kickstart", target]])
        precondition(ServiceAction.restart.commands(domain: "gui/501", label: "com.route2.codex",
                                                    plist: plist, loaded: true) == [["enable", target], ["kickstart", "-k", target]])
        print("Menu-bar status and lifecycle checks passed")
    }
}
