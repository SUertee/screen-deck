// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ScreenDeck",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "ScreenDeck",
            path: "Sources/ScreenDeck"
        ),
        .testTarget(
            name: "ScreenDeckTests",
            dependencies: ["ScreenDeck"],
            path: "Tests/ScreenDeckTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
