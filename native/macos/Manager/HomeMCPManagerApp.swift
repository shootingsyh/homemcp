import SwiftUI
import Foundation
import AppKit

@main
struct HomeMCPManagerApp: App {
    var body: some Scene {
        WindowGroup("HomeMCP") { SetupView().frame(minWidth: 580, minHeight: 440) }
    }
}

struct WizardCheck: Decodable {
    let origin: String
    let passkeyCount: Int
    let complete: Bool
    let connectionMode: String
}

struct SetupView: View {
    @AppStorage("homemcp.wizard.complete") private var completed = false
    @State private var step = 0
    @State private var mode = "byot"
    @State private var domain = ""
    @State private var feedback = "Welcome. Your existing device data will be preserved."
    @State private var running = false

    private var appRoot: String {
        ProcessInfo.processInfo.environment["HOMEMCP_APP_ROOT"] ??
        Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/HomeMCP").path
    }
    private var nodePath: String {
        if let explicit = ProcessInfo.processInfo.environment["HOMEMCP_NODE_PATH"] { return explicit }
        let bundled = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/HomeMCP/runtime/node").path
        if FileManager.default.isExecutableFile(atPath: bundled) || appRoot.hasPrefix("/Applications/") { return bundled }
        for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return bundled
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("HomeMCP").font(.largeTitle).bold()
                Spacer()
                if !completed { Text("Setup \(step + 1) / 3").foregroundStyle(.secondary) }
            }
            Divider()
            if completed {
                dashboard
            } else if step == 0 {
                Text("Choose your connection").font(.title2)
                Picker("Connection", selection: $mode) {
                    Text("Bring Your Own Tunnel · free").tag("byot")
                    Text("HomeMCP Managed · subscription").tag("managed")
                }.pickerStyle(.radioGroup)
                if mode == "managed" {
                    Text("Managed enrollment is not yet available in the Mac installer. This option cannot be completed until the Managed activation flow is implemented.")
                        .foregroundStyle(.secondary)
                } else {
                    Text("Use an HTTPS domain and a tunnel you control. Nothing is registered with the HomeMCP cloud.")
                        .foregroundStyle(.secondary)
                }
                Button("Continue") { step = 1 }
                    .disabled(mode == "managed")
            } else if step == 1 {
                Text("Connect and verify your tunnel").font(.title2)
                Text("Route your HTTPS domain to this computer's HomeMCP Host, then verify it before enrolling a device.")
                    .foregroundStyle(.secondary)
                TextField("https://mcp.example.com", text: $domain).textFieldStyle(.roundedBorder)
                HStack {
                    Button("Back") { step = 0 }
                    Button("Verify and Continue") {
                        runScript("setup.mjs", ["byot", domain]) { _, _ in step = 2 }
                    }.disabled(running || !domain.hasPrefix("https://"))
                }
            } else {
                Text("Register your first Passkey").font(.title2)
                Text("Open the QR code and register a trusted phone or computer. Finish becomes available only after HomeMCP verifies a registered Passkey.")
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Open Setup QR") { runScript("passkey-link.mjs", [], openURL: true) }
                    Button("I've registered — Verify") { checkWizard(advance: true) }
                }.disabled(running)
                Button("Back") { step = 1 }
            }
            Spacer()
            Text(feedback).font(.system(.callout, design: .monospaced))
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(24)
        .onAppear { checkWizard(advance: false) }
    }

    private var dashboard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Your HomeMCP is configured").font(.title2)
            HStack {
                Button("Check Status") { checkWizard(advance: false) }
                Button("Add / Manage Passkeys") { openLocal("/passkeys") }
                Button("New Device QR") { runScript("passkey-link.mjs", [], openURL: true) }
            }.disabled(running)
            Button("Restart local Host") { runScript("setup.mjs", ["restore"]) }
                .disabled(running)
            Divider()
            Button("Restart Setup Wizard…") {
                let alert = NSAlert()
                alert.messageText = "Restart setup wizard?"
                alert.informativeText = "This returns to the first setup page. Existing credentials, domain bindings and Passkeys are preserved. Rebinding an existing domain requires a separate migration."
                alert.addButton(withTitle: "Restart Wizard")
                alert.addButton(withTitle: "Cancel")
                if alert.runModal() == .alertFirstButtonReturn {
                    completed = false
                    step = 0
                    feedback = "Wizard restarted. Existing local data was not deleted."
                }
            }
        }
    }

    private func openLocal(_ suffix: String) {
        let config = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/HomeMCP/config.json")
        guard let data = try? Data(contentsOf: config),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = json["port"] as? Int,
              let url = URL(string: "http://127.0.0.1:\(port)\(suffix)") else {
            feedback = "Local Host configuration is missing."
            return
        }
        NSWorkspace.shared.open(url)
    }

    private func checkWizard(advance: Bool) {
        running = true
        let executable = nodePath
        let script = URL(fileURLWithPath: appRoot).appendingPathComponent("scripts/macos/wizard-check.mjs").path
        Task {
            let result = await Task.detached { ScriptRunner.execute(executable, [script]) }.value
            running = false
            if result.code != 0 {
                feedback = result.output
                return
            }
            guard let payload = result.output.data(using: .utf8),
                  let state = try? JSONDecoder().decode(WizardCheck.self, from: payload) else {
                feedback = "Unable to validate setup status: " + result.output
                return
            }
            if state.complete {
                completed = true
                feedback = "Connected: " + state.origin + " · Passkeys: \(state.passkeyCount)"
            } else {
                completed = false
                if !state.origin.isEmpty {
                    domain = state.origin
                    step = 2
                    feedback = "Domain configured; register and verify a Passkey."
                } else if advance {
                    feedback = "Tunnel and Passkey verification are both required before finishing."
                }
            }
        }
    }

    private func runScript(_ name: String, _ arguments: [String], openURL: Bool = false,
                           success: ((Int32, String) -> Void)? = nil) {
        running = true
        feedback = "Checking…"
        let executable = nodePath
        let script = URL(fileURLWithPath: appRoot).appendingPathComponent("scripts/macos/" + name).path
        Task {
            let result = await Task.detached {
                let version = ScriptRunner.execute(executable, ["--version"])
                if version.code != 0 { return (code: version.code, output: "Node runtime failed: " + executable + "\n" + version.output) }
                return ScriptRunner.execute(executable, [script] + arguments)
            }.value
            running = false
            if result.code != 0 {
                feedback = result.output
                return
            }
            if openURL {
                let value = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
                if let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1" {
                    NSWorkspace.shared.open(url)
                    feedback = "Register your Passkey, then select Verify."
                } else {
                    feedback = "Passkey invitation did not return a valid local URL."
                }
            } else {
                feedback = result.output
                success?(result.code, result.output)
            }
        }
    }
}

private enum ScriptRunner {
    static func execute(_ executable: String, _ arguments: [String]) -> (code: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(decoding: data, as: UTF8.self))
        } catch {
            return (1, "Unable to start HomeMCP: " + error.localizedDescription)
        }
    }
}
