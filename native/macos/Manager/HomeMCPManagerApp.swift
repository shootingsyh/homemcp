import SwiftUI
import Foundation
import AppKit

@main
struct HomeMCPManagerApp: App {
    var body: some Scene {
        WindowGroup("HomeMCP Setup") {
            SetupView()
                .frame(minWidth: 540, minHeight: 440)
        }
    }
}

struct SetupView: View {
    @State private var selectedMode = "managed"
    @State private var domain = ""
    @State private var feedback = "Choose a connection mode. Existing local data is preserved."
    @State private var running = false

    private var appRoot: String {
        ProcessInfo.processInfo.environment["HOMEMCP_APP_ROOT"]
        ?? Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/HomeMCP").path
    }
    private var nodePath: String {
        if let explicit = ProcessInfo.processInfo.environment["HOMEMCP_NODE_PATH"] { return explicit }
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/HomeMCP/runtime/node").path
        if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return "/usr/local/bin/node"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            Text("HomeMCP").font(.largeTitle).fontWeight(.semibold)
            Text("Connect your computer to MCP clients securely.")
                .foregroundStyle(.secondary)

            Picker("Connection", selection: $selectedMode) {
                Text("HomeMCP Managed · subscription").tag("managed")
                Text("Bring Your Own Tunnel · free").tag("byot")
            }
            .pickerStyle(.radioGroup)

            if selectedMode == "byot" {
                TextField("Public HTTPS origin (https://mcp.example.com)", text: $domain)
                    .textFieldStyle(.roundedBorder)
                Text("Your DNS, TLS and tunnel must be set up first. Verification checks that the HTTPS endpoint reaches this HomeMCP and publishes matching OAuth metadata.")
                    .foregroundStyle(.secondary)
                    .font(.caption)
                Button("Verify Tunnel and Activate OAuth") {
                    runScript("setup.mjs", ["byot", domain])
                }
                .disabled(running || domain.isEmpty)
            } else {
                Text("Uses a HomeMCP subdomain and managed FRP. The subscription and cloud domain recovery flow are not yet integrated into this macOS interface.")
                    .foregroundStyle(.secondary)
                Button("Check Existing Managed Configuration") {
                    runScript("setup.mjs", ["status"])
                }
                .disabled(running)
            }

            Divider()

            HStack {
                Button("Restore Saved Local Setup") {
                    runScript("setup.mjs", ["restore"])
                }
                Button("Set Up Passkey (QR)") {
                    runScript("passkey-link.mjs", [], openURL: true)
                }
                Button("Check Status") {
                    runScript("setup.mjs", ["status"])
                }
            }
            .disabled(running)

            Text(feedback)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(24)
    }

    private func runScript(_ filename: String, _ args: [String], openURL: Bool = false) {
        running = true
        feedback = "Checking…"
        let executable = nodePath
        let script = URL(fileURLWithPath: appRoot)
            .appendingPathComponent("scripts/macos/\(filename)").path
        Task {
            let result = await Task.detached {
                ScriptRunner.execute(executable, [script] + args)
            }.value
            running = false
                if result.code == 0 && openURL {
                    let value = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let url = URL(string: value), url.scheme == "http",
                       url.host == "127.0.0.1" {
                        NSWorkspace.shared.open(url)
                        feedback = "Passkey QR opened in your browser."
                    } else {
                        feedback = "Passkey invitation did not return a valid local setup URL."
                    }
                } else {
                    feedback = result.output.isEmpty ? "Exit status: \(result.code)" : result.output
                }
        }
    }
}

private enum ScriptRunner {
    static func execute(_ program: String, _ arguments: [String]) -> (code: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: program)
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
            process.waitUntilExit()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            return (process.terminationStatus, String(decoding: data, as: UTF8.self))
        } catch {
            return (1, "Unable to start HomeMCP setup command: \(error.localizedDescription)")
        }
    }
}
