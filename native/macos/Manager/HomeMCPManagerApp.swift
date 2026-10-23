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
    @State private var managedUser = ""
    @State private var managedPlan = "monthly"
    @State private var feedback = "Welcome. Your existing device data will be preserved."
    @State private var running = false
    @State private var connectionGuide: String? = nil

    private let managedNotice = """
    Privacy & Responsibility

    HomeMCP Managed is an experimental tunnel service offered for testing. We recommend using your own tunnel (Bring Your Own Tunnel) whenever possible. Your HomeMCP Host runs on your own computer. The cloud relay forwards encrypted HTTPS traffic without decrypting your MCP requests, responses, or credentials, and it does not store that traffic. Subscription details such as your account identifier, assigned domain, plan and payment status may be stored to operate the service.

    HomeMCP software, the managed tunnel, and third-party integrations are provided as-is, without promises of uninterrupted availability or error-free operation. You use them at your own risk; the provider does not accept responsibility for problems, losses, or damages arising from their use.
    """

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
                    Text("HomeMCP Managed is an experimental testing service, not a production-grade service. We recommend Bring Your Own Tunnel whenever possible. Managed allocates a HomeMCP subdomain and may require a paid subscription; enrollment requires your confirmation.")
                        .foregroundStyle(.secondary)
                    Text(managedNotice)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } else {
                    Text("Use an HTTPS domain and a tunnel you control. Nothing is registered with the HomeMCP cloud.")
                        .foregroundStyle(.secondary)
                }
                Button("Continue") { step = 1 }
                    .disabled(running)
            } else if step == 1 {
                if mode == "managed" {
                    Text("Activate HomeMCP Managed").font(.title2)
                    Text("Request enrollment once, then select Activate. The app will claim your account automatically when ready.")
                        .foregroundStyle(.secondary)
                    TextField("Desired subdomain username", text: $managedUser).textFieldStyle(.roundedBorder)
                    Picker("Plan", selection: $managedPlan) {
                        Text("Monthly").tag("monthly")
                        Text("Annual").tag("annual")
                    }.pickerStyle(.segmented)
                    HStack {
                        Button("Request Enrollment…") {
                            let alert = NSAlert()
                            alert.messageText = "Request Managed enrollment?"
                            alert.informativeText = "This contacts the HomeMCP subscription service. The selected plan may require payment. No enrollment will be submitted unless you explicitly approve.\n\n"
                            alert.addButton(withTitle: "Submit enrollment")
                            alert.addButton(withTitle: "Cancel")
                            if alert.runModal() == .alertFirstButtonReturn {
                                runScript("managed-setup.mjs", ["enroll", managedUser, managedPlan])
                            }
                        }.disabled(running || managedUser.isEmpty)
                        Button("Check enrollment status") {
                            runScript("managed-setup.mjs", ["claim"])
                        }.disabled(running)
                    }
                    HStack {
                        Button("Back") { step = 0 }
                        Button("Activate Tunnel and Continue") {
                            runScript("managed-setup.mjs", ["activate"]) { _, output in
                                if let text = output.data(using: .utf8),
                                   let json = try? JSONSerialization.jsonObject(with: text) as? [String: Any] {
                                    domain = json["origin"] as? String ?? ""
                                }
                                step = 2
                            }
                        }.buttonStyle(.borderedProminent).controlSize(.large).disabled(running)
                    }
                } else {
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
                }
            } else {
                Text("Connect your phone").font(.title2)
                Text("Scan the setup QR code with your phone and create a Passkey. HomeMCP will verify the connection before finishing.")
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Re-connect / Show QR again") { runScript("passkey-link.mjs", [], openURL: true) }
                        .controlSize(.regular)
                    Button("Verify connection") { checkWizard(advance: true) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                }.disabled(running)
                Button("Back") { step = 1 }
            }
            Spacer()
            Text(feedback).font(.system(.callout, design: .monospaced))
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(24)
        .sheet(item: Binding(
            get: { connectionGuide.map { GuideSelection(id: $0) } },
            set: { connectionGuide = $0?.id }
        )) { selection in
            connectionGuideSheet(selection.id)
        }
        .onChange(of: step) { _, newStep in
            if newStep == 2 && !completed &&
               ProcessInfo.processInfo.environment["HOMEMCP_UI_SMOKE"] != "1" {
                runScript("passkey-link.mjs", [], openURL: true)
            }
        }
        .onAppear {
            if ProcessInfo.processInfo.environment["HOMEMCP_UI_SMOKE"] == "1" {
                // Exercise the actual SwiftUI WindowGroup/view layout without real tunnel,
                // Keychain, browser or network activity.
                let state = ProcessInfo.processInfo.environment["HOMEMCP_UI_SMOKE_PAGE"] ?? "connection"
                completed = state == "dashboard"
                step = state == "tunnel" ? 1 : (state == "passkey" ? 2 : 0)
                let marker = ProcessInfo.processInfo.environment["HOMEMCP_UI_SMOKE_MARKER"] ?? ""
                if !marker.isEmpty {
                    try? ("HOMEMCP_UI_READY:" + state).write(toFile: marker, atomically: true, encoding: .utf8)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { NSApp.terminate(nil) }
            } else {
                checkWizard(advance: false)
            }
        }
    }

    private var dashboard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("HomeMCP is ready").font(.title2).bold()
            Text("Next: connect an AI client to use this computer remotely.")
                .foregroundStyle(.secondary)
            if let endpoint = mcpEndpoint {
                Text("Your MCP endpoint").font(.headline)
                HStack {
                    Text(endpoint).font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                    Button("Copy URL") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(endpoint, forType: .string)
                    }
                }
            }
            Text("Connect your AI client").font(.headline)
            Text("ChatGPT: create a custom MCP plugin using OAuth. Muse: copy a ready-to-use setup prompt with OAuth and HITL instructions.")
                .foregroundStyle(.secondary).font(.callout)
            HStack {
                Button("Connect ChatGPT · Step by step") { connectionGuide = "chatgpt" }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                Button("Connect Muse · Copy prompt") { connectionGuide = "muse" }
                    .controlSize(.large)
            }
            Divider()
            HStack {
                Button("Check Status") { checkWizard(advance: false) }
                Button("Connect another device") { runScript("passkey-link.mjs", [], openURL: true) }
                Button("Manage devices") { openLocal("/passkeys") }
            }.disabled(running)
            Divider()
            Text("Desktop control permissions").font(.headline)
            Text("Accessibility and Screen Recording must be granted to the actual desktop automation helper, not just HomeMCP Manager. The helper is optional and is not yet configured on every Mac.")
                .font(.footnote).foregroundStyle(.secondary)
            HStack {
                Button("Accessibility Settings") { openPrivacySettings("Privacy_Accessibility") }
                Button("Screen Recording Settings") { openPrivacySettings("Privacy_ScreenCapture") }
            }
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

    private func openPrivacySettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?" + pane) {
            NSWorkspace.shared.open(url)
        }
    }

    private var mcpEndpoint: String? {
        let config = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/HomeMCP/config.json")
        guard let data = try? Data(contentsOf: config),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let origin = json["publicUrl"] as? String,
              let url = URL(string: origin),
              url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        return origin.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/mcp"
    }

    private var museConnectionPrompt: String {
        let endpoint = mcpEndpoint ?? "<your HomeMCP HTTPS endpoint>/mcp"
        return """
        Create a remote MCP connection named HomeMCP for my own computer.

        MCP endpoint: \(endpoint)
        This endpoint belongs to the HomeMCP Host running on my own computer. The public frps/tunneld relay only forwards encrypted traffic; it is NOT the MCP server or OAuth provider.
        Transport: Streamable HTTP (HTTPS).
        Authentication: OAuth 2.0 (required). Use HomeMCP's OAuth discovery and authorization endpoints; finish the browser authorization flow. Do not choose No authentication, paste a shared bearer token, or use a local MCP subprocess.

        Register the connection in Muse's MCP settings, complete OAuth user authorization, discover the available tools, and test a harmless read-only tool.

        Human-in-the-loop (HITL) is mandatory for sensitive HomeMCP operations:
        - When a tool requests approval or returns a pending approval ID/link, pause that operation and show me the approval link with a short description of the exact action, target, and risks.
        - I will approve or reject it myself using my registered phone/computer Passkey. Never try to approve for me, impersonate my Passkey, or bypass HomeMCP security.
        - After I decide, use the HomeMCP approval_status / approval_resume / approval_result tools as appropriate to retrieve the decision and resume the SAME pending operation. Follow the tool response contract; do not invent arguments.
        - A pending approval is NOT permission to execute. On denial or expiration, stop and report it. On uncertainty/timeouts, check the existing approval before retrying; never duplicate a potentially destructive operation.
        - ChatGPT or Muse may show its own separate permission prompt; that is distinct from HomeMCP Passkey HITL approval. Do not confuse them.

        Do not store tokens in chat history, and do not disable authentication or security checks.

        Tell me whether the connection and test succeeded. If you cannot configure MCP connections directly, give me the precise manual steps instead.
        """
    }

    @ViewBuilder
    private func connectionGuideSheet(_ provider: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(provider == "chatgpt" ? "Connect ChatGPT" : "Connect Muse")
                    .font(.title2).bold()
                Spacer()
                Button("Done") { connectionGuide = nil }
            }
            if let endpoint = mcpEndpoint {
                Text("HomeMCP Host on this computer").font(.headline)
                Text(endpoint).font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                Button("Copy MCP URL") { NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(endpoint, forType: .string) }
            } else {
                Text("Complete tunnel setup first. The tunnel only forwards to the MCP Host running on this computer.")
                    .foregroundStyle(.red)
            }
            if provider == "chatgpt" {
                Text("Connect ChatGPT to your local HomeMCP Host:").font(.headline)
                Text("1. Open chatgpt.com and go to Plugins.\n2. Select + (Add) → Add custom MCP server.\n3. Name it HomeMCP. Paste the MCP URL above under Connection.\n4. Select OAuth as the authentication method (required for HomeMCP). Complete HomeMCP's browser sign-in and authorization flow.\n5. Acknowledge the security warning and select Create as a plugin.\n6. Install the plugin, open Work, and use @HomeMCP to test a read-only tool.")
                    .textSelection(.enabled)
                Text("The available options depend on your ChatGPT plan and workspace permissions.")
                    .foregroundStyle(.secondary).font(.footnote)
                Button("Open ChatGPT") { NSWorkspace.shared.open(URL(string: "https://chatgpt.com")!) }
                    .buttonStyle(.borderedProminent)
            } else {
                Text("Copy this prompt into Muse:").font(.headline)
                ScrollView {
                    Text(museConnectionPrompt).font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 260)
                Button("Copy Muse setup prompt") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(museConnectionPrompt, forType: .string)
                }.buttonStyle(.borderedProminent)
            }
            Spacer(minLength: 0)
        }
        .padding(24).frame(width: 640, height: provider == "chatgpt" ? 570 : 530)
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
                           stdin: String? = nil, success: ((Int32, String) -> Void)? = nil) {
        running = true
        feedback = "Checking…"
        let executable = nodePath
        let script = URL(fileURLWithPath: appRoot).appendingPathComponent("scripts/macos/" + name).path
        Task {
            let result = await Task.detached {
                let version = ScriptRunner.execute(executable, ["--version"])
                if version.code != 0 { return (code: version.code, output: "Node runtime failed: " + executable + "\n" + version.output) }
                return ScriptRunner.execute(executable, [script] + arguments, stdin: stdin)
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

private struct GuideSelection: Identifiable { let id: String }

private enum ScriptRunner {
    static func execute(_ executable: String, _ arguments: [String], stdin: String? = nil) -> (code: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        if let stdin {
            let input = Pipe()
            process.standardInput = input
            try? input.fileHandleForWriting.write(contentsOf: Data(stdin.utf8))
            try? input.fileHandleForWriting.close()
        }
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
