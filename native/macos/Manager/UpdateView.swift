import SwiftUI
import AppKit
import Foundation

struct UpdateView: View {
    @State private var localPackage = ""
    @State private var remoteURL = ""
    @State private var checksum = ""
    @State private var useRemote = false
    @State private var busy = false
    @State private var message = "Choose a trusted local build or an HTTPS download."
    @State private var jobPath = ""
    @State private var phase = ""
    private let updates = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/HomeMCP/updates")
    private var root: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/HomeMCP") }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Update HomeMCP").font(.title).bold()
            Text("Installed: \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown")")
            Picker("Build source", selection: $useRemote) {
                Text("Local build").tag(false)
                Text("Remote build").tag(true)
            }.pickerStyle(.segmented).disabled(busy)
            if useRemote {
                TextField("HTTPS package URL", text: $remoteURL).textFieldStyle(.roundedBorder)
                TextField("Trusted SHA-256 (required)", text: $checksum).textFieldStyle(.roundedBorder)
                Text("Get the checksum from the build producer. Private release URLs must be directly downloadable; signed HTTPS download links are supported.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                TextField("Local .pkg path", text: $localPackage).textFieldStyle(.roundedBorder)
                HStack {
                    Button("Find Local Build") { discover() }
                    Button("Choose Package…") {
                        let panel = NSOpenPanel()
                        panel.canChooseDirectories = false
                        panel.allowsMultipleSelection = false
                        if panel.runModal() == .OK, let url = panel.url { localPackage = url.path }
                    }
                }.disabled(busy)
            }
            Text("Install only builds you trust. Installer packages can run administrator scripts. macOS may ask for an administrator password. Updates continue locally even if MCP disconnects.")
                .font(.footnote).foregroundStyle(.secondary)
            HStack {
                Button("Install Update…") { install() }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || (useRemote ? remoteURL.isEmpty || checksum.isEmpty : localPackage.isEmpty))
                if !jobPath.isEmpty {
                    Button("Show Update Logs") { NSWorkspace.shared.open(URL(fileURLWithPath: jobPath)) }
                }
            }
            Divider()
            Text(phase).bold()
            Text(message).textSelection(.enabled)
            Spacer()
        }
        .padding(24).frame(minWidth: 600, minHeight: 440)
        .task {
            while !Task.isCancelled {
                refreshStatus()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func refreshStatus() {
        if jobPath.isEmpty,
           let data = try? Data(contentsOf: updates.appendingPathComponent("latest.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let job = obj["job"] as? String { jobPath = job }
        guard !jobPath.isEmpty,
              let data = try? Data(contentsOf: URL(fileURLWithPath: jobPath).appendingPathComponent("status.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        phase = obj["phase"] as? String ?? ""
        message = obj["detail"] as? String ?? ""
        busy = !["complete", "failed", "needs_attention"].contains(phase)
    }

    private func discover() {
        busy = true
        Task {
            let result = await run(["discover"])
            busy = false
            if result.0 == 0, let data = result.1.data(using: .utf8),
               let builds = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
               let pkg = builds.first?["pkg"] as? String {
                localPackage = pkg
                message = "Selected the newest HomeMCP package from ~/homemcp/build/macos-dist or Downloads."
            } else { message = result.0 == 0 ? "No local build found. Use Choose Package for another directory." : result.1 }
        }
    }

    private func install() {
        let alert = NSAlert()
        alert.messageText = "Install this HomeMCP build?"
        alert.informativeText = useRemote ? remoteURL + "\nSHA-256: " + checksum : localPackage
        alert.addButton(withTitle: "Install")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let source: [String: String] = useRemote
            ? ["url": remoteURL.trimmingCharacters(in: .whitespacesAndNewlines), "sha256": checksum.trimmingCharacters(in: .whitespacesAndNewlines)]
            : ["pkg": localPackage]
        guard let data = try? JSONSerialization.data(withJSONObject: source),
              let json = String(data: data, encoding: .utf8) else { return }
        busy = true
        Task {
            let result = await run(["launch", json])
            if result.0 == 0, let bytes = result.1.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
               let job = obj["job"] as? String {
                jobPath = job
                refreshStatus()
            } else { busy = false; message = result.1 }
        }
    }

    private func run(_ arguments: [String]) async -> (Int32, String) {
        let node = root.appendingPathComponent("runtime/node").path
        let script = root.appendingPathComponent("scripts/macos/update.mjs").path
        return await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [script] + arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
                let output = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                return (process.terminationStatus, String(decoding: output, as: UTF8.self))
            } catch { return (1, error.localizedDescription) }
        }.value
    }
}
