// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ScreenDeck",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/LebJe/TOMLKit.git", exact: "0.6.0")
    ],
    targets: [
        .executableTarget(
            name: "ScreenDeck",
            dependencies: [.product(name: "TOMLKit", package: "TOMLKit")],
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
