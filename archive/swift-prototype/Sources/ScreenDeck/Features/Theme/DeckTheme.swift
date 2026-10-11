import SwiftUI

/// Shared semantic palette. The notch deliberately remains black in both appearances.
enum DeckTheme {
    struct Palette {
        let background: UInt32
        let surface: UInt32
        let text: UInt32
        let secondary: UInt32
        let accent: UInt32
        let onAccent: UInt32
        let selection: UInt32
    }

    // User-approved monochrome: luminance, icons and labels carry the hierarchy.
    static let dark = Palette(background: 0x000000, surface: 0x171717, text: 0xF2F2F2,
                              secondary: 0xABABAB, accent: 0xEEEEEE, onAccent: 0x171717, selection: 0x292929)
    static let light = Palette(background: 0xF5F5F5, surface: 0xFCFCFC, text: 0x1C1C1C,
                               secondary: 0x626262, accent: 0x202020, onAccent: 0xFCFCFC, selection: 0xEAEAEA)
    static func palette(_ scheme: ColorScheme) -> Palette { scheme == .dark ? dark : light }
    static func color(_ hex: UInt32) -> Color {
        Color(.sRGB, red: Double((hex >> 16) & 255) / 255,
              green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1)
    }
    static let accent = color(dark.accent)
    static let surface = color(dark.surface)
    static let text = color(dark.text)
    static let secondary = color(dark.secondary)
}

struct DeckPrimaryButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        let palette = DeckTheme.palette(scheme)
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(DeckTheme.color(palette.onAccent))
            .background(DeckTheme.color(palette.accent), in: RoundedRectangle(cornerRadius: 8))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
    }
}
