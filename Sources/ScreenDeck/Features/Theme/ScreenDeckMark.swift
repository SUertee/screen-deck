import SwiftUI

/// Two true half-discs, with a fixed small seam. Never stretch into capsules.
struct ScreenDeckMark: View {
    static let diameter: CGFloat = 22
    static let seam: CGFloat = 2

    var body: some View {
        HStack(spacing: Self.seam) {
            HalfDisc(mirrored: true).frame(width: Self.diameter / 2, height: Self.diameter)
            HalfDisc().frame(width: Self.diameter / 2, height: Self.diameter)
        }
        .frame(width: Self.diameter + Self.seam, height: Self.diameter)
        .accessibilityHidden(true)
    }
}

struct HalfDisc: Shape {
    var mirrored = false

    func path(in rect: CGRect) -> Path {
        let radius = min(rect.width, rect.height / 2)
        let origin = CGPoint(x: rect.midX - radius / 2, y: rect.midY - radius)
        let k = radius * 0.5522847498
        var path = Path()
        path.move(to: CGPoint(x: radius, y: 0))
        path.addCurve(to: CGPoint(x: 0, y: radius), control1: CGPoint(x: radius - k, y: 0), control2: CGPoint(x: 0, y: radius - k))
        path.addCurve(to: CGPoint(x: radius, y: radius * 2), control1: CGPoint(x: 0, y: radius + k), control2: CGPoint(x: radius - k, y: radius * 2))
        path.closeSubpath()
        if mirrored { path = path.applying(CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: radius, ty: 0)) }
        return path.applying(CGAffineTransform(translationX: origin.x, y: origin.y))
    }
}
