// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "overload-island",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "overload-island", targets: ["overload-island"]),
    ],
    targets: [
        .executableTarget(name: "overload-island"),
    ]
)
