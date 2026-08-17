import AppKit

@MainActor
protocol IslandContentViewDelegate: AnyObject {
    func islandContentViewMouseEntered()
    func islandContentViewMouseExited()
    func islandContentViewDidRequestCopy(_ binding: String)
}

final class IslandContentView: NSVisualEffectView {
    weak var delegate: IslandContentViewDelegate?
    private let dot = NSView()
    private let statusLabel = NSTextField(labelWithString: "正在连接…")
    private let titleLabel = NSTextField(labelWithString: "Overload · Q1 待决策")
    private let rowsStack = NSStackView()
    private let collapsedStack = NSStackView()
    private let expandedStack = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active
        appearance = NSAppearance(named: .vibrantDark)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedRed: 28/255, green: 28/255, blue: 30/255, alpha: 0.82).cgColor
        layer?.masksToBounds = true
        configureSubviews()
        addTrackingArea(NSTrackingArea(rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func configureSubviews() {
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 8), dot.heightAnchor.constraint(equalToConstant: 8)])
        setDot(healthy: true)

        statusLabel.font = .systemFont(ofSize: 12, weight: .medium)
        statusLabel.textColor = NSColor(calibratedWhite: 245/255, alpha: 1)
        statusLabel.lineBreakMode = .byTruncatingTail

        collapsedStack.orientation = .horizontal
        collapsedStack.alignment = .centerY
        collapsedStack.spacing = 9
        collapsedStack.addArrangedSubview(dot)
        collapsedStack.addArrangedSubview(statusLabel)

        titleLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        titleLabel.textColor = NSColor(calibratedWhite: 245/255, alpha: 1)
        rowsStack.orientation = .vertical
        rowsStack.alignment = .width
        rowsStack.spacing = 8

        expandedStack.orientation = .vertical
        expandedStack.alignment = .width
        expandedStack.spacing = 10
        expandedStack.addArrangedSubview(titleLabel)
        expandedStack.addArrangedSubview(rowsStack)
        expandedStack.isHidden = true

        [collapsedStack, expandedStack].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            addSubview($0)
        }
        NSLayoutConstraint.activate([
            collapsedStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            collapsedStack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
            collapsedStack.centerYAnchor.constraint(equalTo: centerYAnchor),
            expandedStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            expandedStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            expandedStack.topAnchor.constraint(equalTo: topAnchor, constant: 15),
        ])
    }

    override func mouseEntered(with event: NSEvent) { delegate?.islandContentViewMouseEntered() }
    override func mouseExited(with event: NSEvent) { delegate?.islandContentViewMouseExited() }

    func setExpanded(_ expanded: Bool) {
        collapsedStack.isHidden = expanded
        expandedStack.isHidden = !expanded
        layer?.cornerRadius = expanded ? 20 : 999
        // KNOWN OPEN ISSUE (see docs/plans/overload-20260816-island-web-design.md
        // §7 residual risks): on this development machine, N24's acceptance pass
        // reproduced a real, deterministic bug (window-scoped CGWindowListCreateImage
        // capture, 2/2 reproduction) where the panel's backing surface goes fully
        // transparent after collapsing back down from expanded, even though the
        // window remains correctly tracked on-screen at the right level/bounds.
        // Isolated minimal repros (plain layer-backed NSView, no NSVisualEffectView,
        // no NSStackView, animated AND non-animated setFrame, even a freshly
        // recreated NSPanel at the same frame) confirm the deciding factor is
        // `isOpaque = false` — the identical repro renders correctly at every step
        // with `isOpaque = true`. No fix that preserves rounded/transparent corners
        // was found to reliably resolve it (needsDisplay/viewsNeedDisplay/
        // displayIfNeeded/orderFront/contentView-reset/layerContentsRedrawPolicy
        // were all tried and did not conclusively help — later re-tests were also
        // confounded by this being an actively shared, concurrently-used machine,
        // so some of those negative results are themselves uncertain). The two
        // calls below are cheap and can only help; they are NOT a confirmed fix.
        // Do not remove this comment until re-verified clean on an idle machine.
        needsDisplay = true
        window?.displayIfNeeded()
    }

    func showSummary(_ summary: Summary) {
        setDot(healthy: summary.isHealthy)
        statusLabel.stringValue = "Q1 · \(summary.q1) 待决策   Q2 · \(summary.q2) 已完成"
    }

    func showOffline() {
        setDot(healthy: false)
        statusLabel.stringValue = "离线"
        titleLabel.stringValue = "Overload · 离线"
        showRows([])
    }

    func showRows(_ rows: [Q1Row]) {
        rowsStack.arrangedSubviews.forEach { view in rowsStack.removeArrangedSubview(view); view.removeFromSuperview() }
        titleLabel.stringValue = "Overload · Q1 待决策（\(rows.count)）"
        if rows.isEmpty {
            let empty = label("暂无待决策项", size: 12, color: .secondaryLabelColor)
            rowsStack.addArrangedSubview(empty)
            return
        }
        for row in rows.prefix(4) { rowsStack.addArrangedSubview(makeRow(row)) }
    }

    private func makeRow(_ row: Q1Row) -> NSView {
        let container = NSStackView()
        container.orientation = .horizontal
        container.alignment = .centerY
        container.spacing = 8

        let text = NSStackView()
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        let main = label(row.displayText, size: 12, color: NSColor(calibratedWhite: 245/255, alpha: 1))
        main.lineBreakMode = .byTruncatingTail
        let meta = label(row.metaText, size: 10, color: .secondaryLabelColor)
        meta.lineBreakMode = .byTruncatingMiddle
        text.addArrangedSubview(main)
        text.addArrangedSubview(meta)
        text.setHuggingPriority(.defaultLow, for: .horizontal)

        let button = BindingButton(title: "复制跳转标识", target: self, action: #selector(copyBinding(_:)))
        button.binding = row.copyBinding
        button.bezelStyle = .roundRect
        button.controlSize = .small
        container.addArrangedSubview(text)
        container.addArrangedSubview(button)
        return container
    }

    private func label(_ text: String, size: CGFloat, color: NSColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size)
        field.textColor = color
        return field
    }

    @objc private func copyBinding(_ sender: BindingButton) {
        delegate?.islandContentViewDidRequestCopy(sender.binding)
    }

    private func setDot(healthy: Bool) {
        let color = healthy ? NSColor.systemGreen : NSColor(calibratedRed: 1, green: 69/255, blue: 58/255, alpha: 1)
        dot.layer?.backgroundColor = color.cgColor
        dot.layer?.shadowColor = color.cgColor
        dot.layer?.shadowOpacity = 0.8
        dot.layer?.shadowRadius = 5
        dot.layer?.shadowOffset = .zero
    }
}

private final class BindingButton: NSButton {
    var binding = "无跳转标识"
}
