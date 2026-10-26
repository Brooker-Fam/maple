import SwiftUI

struct OfflineView: View {
    let failure: LoadFailure
    let onRetry: () -> Void

    private var title: String {
        switch failure {
        case .offline: "You're offline"
        case .unreachable: "Maple's Log can't load right now"
        }
    }

    private var message: String {
        switch failure {
        case .offline: "Maple's Log opens again as soon as you're back on Wi-Fi or cellular."
        case .unreachable: "It's usually back in a moment. Please try again shortly."
        }
    }

    var body: some View {
        ZStack {
            Color.mapleBackground.ignoresSafeArea()
            VStack(spacing: 0) {
                Image(.mapleMark)
                    .resizable()
                    .frame(width: 56, height: 56)
                    .frame(width: 88, height: 88)
                    .background(Color.mapleSurface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .strokeBorder(Color.mapleInk.opacity(0.1))
                    )
                    .accessibilityHidden(true)
                Text(title)
                    .font(.system(size: 28, weight: .semibold, design: .serif))
                    .foregroundStyle(Color.mapleInk)
                    .multilineTextAlignment(.center)
                    .padding(.top, 24)
                Text(message)
                    .font(.system(size: 15))
                    .foregroundStyle(Color.mapleInk2)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .frame(maxWidth: 300)
                    .padding(.top, 8)
                Button(action: onRetry) {
                    Text("Try again")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .foregroundStyle(Color.mapleOnAccent)
                        .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .padding(.top, 32)
            }
            .frame(maxWidth: 384)
            .padding(.horizontal, 20)
        }
    }
}

#Preview("Offline") {
    OfflineView(failure: .offline, onRetry: {})
}

#Preview("Unreachable") {
    OfflineView(failure: .unreachable, onRetry: {})
}
