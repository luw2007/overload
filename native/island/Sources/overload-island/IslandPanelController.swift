import AppKit
import QuartzCore

@MainActor
final class IslandPanelController: NSObject, IslandContentViewDelegate {
    private let panel: NSPanel
    private let contentView: IslandContentView
    private let client: SummaryClient
    private var pollingTimer: Timer?
    private var hoverOpenTimer: Timer?
    private var mouseLeaveCloseTimer: Timer?
    private(set) var isExpanded = false
    private var isCollapsing = false

    private let collapsedSize = NSSize(width: 340, height: 36)
    private let expandedSize = NSSize(width: 340, height: 220)
    private let hoverOpenDelay: TimeInterval = 0.2
    private let mouseLeaveCloseDelay: TimeInterval = 0.3

    override init() {
        client = SummaryClient()
        contentView = IslandContentView(frame: .zero)
        let initial = IslandPanelController.frame(for: NSSize(width: 340, height: 36))
        panel = NSPanel(contentRect: initial, styleMask: [.nonactivatingPanel, .borderless],
                        backing: .buffered, defer: false)
        super.init()
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.contentView = contentView
        contentView.delegate = self
    }

    func start() {
        panel.orderFrontRegardless()
        refreshSummary()
        pollingTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshSummary() }
        }
    }

    func islandContentViewMouseEntered() {
        mouseLeaveCloseTimer?.invalidate()
        mouseLeaveCloseTimer = nil
        guard !isExpanded, hoverOpenTimer == nil else { return }
        hoverOpenTimer = Timer.scheduledTimer(withTimeInterval: hoverOpenDelay, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.hoverOpenTimer = nil
                self.expand()
            }
        }
    }

    func islandContentViewMouseExited() {
        hoverOpenTimer?.invalidate()
        hoverOpenTimer = nil
        guard isExpanded, !isCollapsing, mouseLeaveCloseTimer == nil else { return }
        mouseLeaveCloseTimer = Timer.scheduledTimer(withTimeInterval: mouseLeaveCloseDelay, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.mouseLeaveCloseTimer = nil
                guard !self.panel.frame.contains(NSEvent.mouseLocation) else { return }
                self.collapse()
            }
        }
    }

    func islandContentViewDidRequestCopy(_ binding: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(binding, forType: .string)
    }

    private func expand() {
        guard !isExpanded else { return }
        isExpanded = true
        isCollapsing = false
        contentView.setExpanded(true)
        client.fetchQ1 { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let rows): self.contentView.showRows(rows)
            case .failure: self.contentView.showOffline()
            }
        }
        animate(to: Self.frame(for: expandedSize), duration: 0.5,
                timing: CAMediaTimingFunction(controlPoints: 0.34, 1.56, 0.64, 1))
    }

    private func collapse() {
        guard isExpanded, !isCollapsing else { return }
        isExpanded = false
        isCollapsing = true
        animate(to: Self.frame(for: collapsedSize), duration: 0.3,
                timing: CAMediaTimingFunction(name: .easeOut)) { [weak self] in
            guard let self else { return }
            self.isCollapsing = false
            self.contentView.setExpanded(false)
        }
    }

    private func animate(to frame: NSRect, duration: TimeInterval, timing: CAMediaTimingFunction,
                         completion: (() -> Void)? = nil) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = timing
            panel.animator().setFrame(frame, display: true)
        } completionHandler: { completion?() }
    }

    private func refreshSummary() {
        client.fetchSummary { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let summary): self.contentView.showSummary(summary)
            case .failure: self.contentView.showOffline()
            }
        }
    }

    private static func frame(for size: NSSize) -> NSRect {
        let screen = NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.frame ?? NSRect(x: 0, y: 0, width: size.width, height: size.height + 8)
        return NSRect(x: visible.midX - size.width / 2,
                      y: visible.maxY - 8 - size.height,
                      width: size.width, height: size.height)
    }
}
