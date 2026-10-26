import UIKit
import WebKit

extension MapleBrowser: WKDownloadDelegate {
    private var downloadsFolder: URL {
        FileManager.default.temporaryDirectory.appending(path: "Downloads", directoryHint: .isDirectory)
    }

    // An export is the whole log; it should not outlive the share sheet it was made for.
    func clearDownloads() {
        try? FileManager.default.removeItem(at: downloadsFolder)
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping @MainActor (URL?) -> Void
    ) {
        let folder = downloadsFolder.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            completionHandler(nil)
            return
        }
        let name = (suggestedFilename as NSString).lastPathComponent
        let destination = folder.appending(path: name.isEmpty ? "maple-export.csv" : name)
        pendingDownloads[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = pendingDownloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        present(sheet)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = pendingDownloads.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        let alert = UIAlertController(
            title: "Download didn't finish",
            message: "Check your connection and try again.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert)
    }
}
