import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var island: IslandPanelController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            island = IslandPanelController()
            island?.start()
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
