import SwiftUI
import AppKit
import ImageIO

/// The product owns these content tabs; the macOS window still owns native window controls.
struct TaskWorkspaceTabsView: View {
    let session: TaskWorkspaceSession
    var taskLabel = "任务详情"
    let references: [ProjectFileReference]
    let isLoading: Bool
    let onTask: () -> Void
    let onSelect: (WorkspaceAttachmentID) -> Void
    let onCloseFile: (WorkspaceAttachmentID) -> Void
    let onReference: (ProjectFileReference) -> Void
    let onClosePane: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            ScrollViewReader { reader in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 3) {
                        tab(title: taskLabel, icon: "doc.text", selected: session.selectedAttachmentID == nil,
                            select: onTask, close: onClosePane)
                            .id("task")
                        ForEach(session.attachments) { item in
                            tab(title: item.preview.fileName, icon: icon(item),
                                selected: session.selectedAttachmentID == item.id,
                                select: { onSelect(item.id) }, close: { onCloseFile(item.id) })
                                .id(item.id)
                                .help(item.reference.label + "\n" + item.reference.path)
                        }
                    }.padding(.leading, 6)
                }
                .onChange(of: session.selectedAttachmentID) { _, selected in
                    if let selected { reader.scrollTo(selected, anchor: .trailing) }
                    else { reader.scrollTo("task", anchor: .leading) }
                }
                .onAppear {
                    if let selected = session.selectedAttachmentID { reader.scrollTo(selected, anchor: .trailing) }
                }
            }
            if isLoading {
                ProgressView().controlSize(.small).frame(width: 28).accessibilityLabel("正在读取附件")
            } else {
                Menu {
                    if references.isEmpty { Text("当前没有已登记附件") }
                    ForEach(references, id: \.path) { reference in
                        Button(reference.label + " · " + reference.path) { onReference(reference) }
                    }
                } label: {
                    Image(systemName: "plus").frame(width: 28, height: 30)
                }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .disabled(references.isEmpty)
                    .help("打开本任务已登记的附件").accessibilityLabel("打开任务附件")
            }
            Button(action: onClosePane) {
                Image(systemName: "sidebar.right").frame(width: 28, height: 30)
            }.buttonStyle(.plain).help("收起右侧工作区").accessibilityLabel("收起右侧工作区")
        }
        .padding(.trailing, 10)
        .frame(height: WorkbenchWindowChrome.headerHeight)
        .background(WorkbenchStyle.rail)
        .background { WorkbenchWindowDragRegion() }
    }

    private func tab(title: String, icon: String, selected: Bool, select: @escaping () -> Void,
                     close: @escaping () -> Void) -> some View {
        HStack(spacing: 3) {
            Button(action: select) {
                Label(title, systemImage: icon)
                    .font(.system(size: 12, weight: selected ? .semibold : .regular))
                    .lineLimit(1).truncationMode(.middle)
                    .frame(minWidth: 65, maxWidth: 128, alignment: .leading)
                    .padding(.leading, 10).padding(.vertical, 10)
            }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .medium))
                    .frame(width: 24, height: 30)
            }.buttonStyle(.plain).help("关闭 " + title).accessibilityLabel("关闭 " + title)
        }.padding(.trailing, 3)
            .background(selected ? WorkbenchStyle.surface : WorkbenchStyle.ink.opacity(0.025),
                        in: RoundedRectangle(cornerRadius: 7))
    }

    private func icon(_ attachment: WorkspaceAttachment) -> String {
        if case .image = attachment.preview.content { return "photo" }
        return "doc.text"
    }
}

struct TaskInspectorNavigationView: View {
    @Binding var tab: TaskInspectorTab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(TaskInspectorTab.allCases, id: \.self) { value in
                Button { tab = value } label: {
                    Text(value.rawValue)
                        .font(.system(size: 13, weight: tab == value ? .semibold : .regular))
                        .frame(maxWidth: .infinity).frame(height: 48)
                        .overlay(alignment: .bottom) {
                            if tab == value { Capsule().fill(WorkbenchStyle.ink).frame(width: 28, height: 2) }
                        }
                }.buttonStyle(.plain).accessibilityAddTraits(tab == value ? .isSelected : [])
            }
        }.padding(.horizontal, 16)
    }
}

/// Read-only text/first-frame bitmap preview. No HTML, embedded code, network links or edits.
struct WorkspaceAttachmentPreviewView: View {
    let attachment: WorkspaceAttachment
    let stale: Bool
    let onReload: () -> Void
    let onOpenExternal: () -> Void
    let onTask: () -> Void
    private let textPreviewLimit = 120_000

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Button(action: onTask) { Label("返回任务", systemImage: "arrow.left") }
                    .buttonStyle(.plain).font(.system(size: 12))
                Spacer(minLength: 8)
                Button(action: onReload) { Image(systemName: "arrow.clockwise").frame(width: 28, height: 28) }
                    .buttonStyle(.plain).disabled(stale)
                    .help("重新读取这份附件").accessibilityLabel("重新读取附件")
                Button("打开", action: onOpenExternal).buttonStyle(.plain).font(.system(size: 12))
                    .disabled(stale).help("在系统应用中打开原文件")
            }.padding(.horizontal, 20).frame(height: 48)
            Divider()
            if stale {
                Label("来源已失效，当前为已读取的预览。请先刷新或重新关联项目。", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 12)).foregroundStyle(WorkbenchStyle.muted)
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(WorkbenchStyle.rail)
            }
            switch attachment.preview.content {
            case .text(let text):
                GeometryReader { viewport in
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: 14) {
                            Text(String(text.prefix(textPreviewLimit)))
                                .font(.system(size: 13, design: .monospaced))
                                .lineSpacing(4).textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if text.count > textPreviewLimit {
                                Text("预览仅显示前 \(textPreviewLimit) 个字符。原文件未改动，可在系统应用中完整打开。")
                                    .font(.system(size: 12)).foregroundStyle(WorkbenchStyle.muted)
                            }
                        }
                        .frame(width: max(1, viewport.size.width - 44), alignment: .leading)
                        .frame(minHeight: max(1, viewport.size.height - 44), alignment: .topLeading)
                        .padding(22)
                    }
                }
            case .image(let data):
                GeometryReader { viewport in
                    ScrollView(.vertical) {
                        if let source = CGImageSourceCreateWithData(data as CFData, nil),
                           let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
                            Image(decorative: image, scale: 1).resizable().scaledToFit()
                                .frame(width: max(1, viewport.size.width - 40)).padding(20)
                                .accessibilityLabel(attachment.reference.label)
                        } else {
                            Text("图片无法解码，请重新读取。").padding(22)
                        }
                    }
                }
            }
            Divider()
            HStack {
                Text(attachment.reference.path).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Text(attachment.preview.loadedAt.formatted(date: .omitted, time: .shortened)).monospacedDigit()
            }.font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted).padding(12)
                .help("只读预览，读取时间不等于产物生成时间")
        }.background(WorkbenchStyle.surface)
    }
}
