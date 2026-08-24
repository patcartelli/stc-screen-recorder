// swift-tools-version:5.8
import PackageDescription

let package = Package(
    name: "stc-helper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "stc-helper", path: "src")
    ]
)
