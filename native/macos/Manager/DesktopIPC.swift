import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit

func send(_ result: [String:Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: result),
       let text = String(data: data, encoding: .utf8) { print(text) }
}
func check() -> [String:Any] {
    ["accessibility": AXIsProcessTrusted(), "screen_recording": CGPreflightScreenCaptureAccess()]
}
func execute(_ req:[String:Any]) async -> [String:Any] {
    let name=req["tool"] as? String ?? ""
    let args=req["arguments"] as? [String:Any] ?? [:]
    if name=="desktop_permissions" { return check() }
    if name=="desktop_request_screen_recording" {
        let granted = await MainActor.run { CGRequestScreenCaptureAccess() }
        return ["screen_recording": granted, "permission_subject": "HomeMCP Manager", "restart_may_be_required": !granted]
    }
    if name=="desktop_screenshot" {
        guard CGPreflightScreenCaptureAccess() else {return ["error":"screen_recording_permission_required","permission_subject":"HomeMCP Manager","next_step":"Use Request Screen Recording in HomeMCP Manager, then enable the displayed HomeMCP component in System Settings > Privacy & Security > Screen & System Audio Recording. Restart the Host if macOS asks."]}
        guard #available(macOS 14.0, *) else { return ["error":"screenshot_requires_macos_14"] }
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else { return ["error":"no_display"] }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = display.width
            configuration.height = display.height
            configuration.showsCursor = false
            let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            guard let data = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) else {
                return ["error":"capture_encoding_failed"]
            }
            return ["mime_type":"image/png","image_base64":data.base64EncodedString(),"width":img.width,"height":img.height]
        } catch {
            return ["error":"capture_failed","detail":String(describing: error)]
        }
    }
    guard AXIsProcessTrusted() else {return ["error":"accessibility_permission_required"]}
    if name=="desktop_snapshot" {
        let system=AXUIElementCreateSystemWide()
        var app:CFTypeRef?
        guard AXUIElementCopyAttributeValue(system,kAXFocusedApplicationAttribute as CFString,&app) == .success,
              let application=app else {return ["error":"no_focused_application"]}
        var title:CFTypeRef?,window:CFTypeRef?
        let element=application as! AXUIElement
        _ = AXUIElementCopyAttributeValue(element,kAXTitleAttribute as CFString,&title)
        _ = AXUIElementCopyAttributeValue(element,kAXFocusedWindowAttribute as CFString,&window)
        var windowTitle:CFTypeRef?
        if let window { _ = AXUIElementCopyAttributeValue(window as! AXUIElement,kAXTitleAttribute as CFString,&windowTitle) }
        return ["app":title as? String ?? "","window":windowTitle as? String ?? ""]
    }
    if name=="desktop_click" {
        guard let x=args["x"] as? Double,let y=args["y"] as? Double,
              let down=CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:CGPoint(x:x,y:y),mouseButton:.left),
              let up=CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:CGPoint(x:x,y:y),mouseButton:.left) else {return ["error":"invalid_click"]}
        down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
        return ["ok":true]
    }
    if name=="desktop_type" {
        guard let text=args["text"] as? String,text.utf16.count<=4096 else {return ["error":"invalid_text"]}
        let units=Array(text.utf16)
        guard let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true),
              let up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false) else {return ["error":"event_creation_failed"]}
        down.keyboardSetUnicodeString(stringLength:units.count,unicodeString:units)
        up.keyboardSetUnicodeString(stringLength:units.count,unicodeString:units)
        down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
        return ["ok":true]
    }
    if name=="desktop_scroll" {
        guard let lines=args["lines"] as? Int,abs(lines)<=100,
              let event=CGEvent(scrollWheelEvent2Source:nil,units:.line,wheelCount:1,wheel1:Int32(lines),wheel2:0,wheel3:0) else {return ["error":"invalid_scroll"]}
        event.post(tap:.cghidEventTap)
        return ["ok":true]
    }
    if name=="desktop_shortcut" {
        guard let key=args["keycode"] as? Int,key>=0,key<=127 else {return ["error":"invalid_keycode"]}
        var flags:CGEventFlags=[]
        for modifier in args["modifiers"] as? [String] ?? [] {
            switch modifier {
            case "command":flags.insert(.maskCommand)
            case "shift":flags.insert(.maskShift)
            case "option":flags.insert(.maskAlternate)
            case "control":flags.insert(.maskControl)
            default:return ["error":"invalid_modifier"]
            }
        }
        guard let down=CGEvent(keyboardEventSource:nil,virtualKey:CGKeyCode(key),keyDown:true),
              let up=CGEvent(keyboardEventSource:nil,virtualKey:CGKeyCode(key),keyDown:false) else {return ["error":"event_creation_failed"]}
        down.flags=flags;up.flags=flags;down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
        return ["ok":true]
    }
    return ["error":"unknown_tool"]
}

// Persistent native desktop endpoint: Unix socket belongs to the logged-in user.
// The Node Host connects over this socket, never directly launches capture per call.
func serve(socketPath: String) {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { fputs("socket_failed\n", stderr); exit(1) }
    defer { close(fd) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { exit(2) }
    withUnsafeMutableBytes(of: &address.sun_path) { dst in
        dst.copyBytes(from: bytes.map { UInt8(bitPattern: $0) })
    }
    unlink(socketPath)
    let bound = withUnsafePointer(to: &address) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard bound == 0, chmod(socketPath, 0o600) == 0, listen(fd, 8) == 0 else {
        fputs("socket_bind_failed\n", stderr); exit(3)
    }
    while true {
        let client = accept(fd, nil, nil)
        if client < 0 { continue }
        // Each request has its own connection; tools execute serially to avoid focus races.
        var collected = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while collected.count < 1_048_576 {
            let n = read(client, &buffer, buffer.count)
            if n <= 0 { break }
            collected.append(contentsOf: buffer.prefix(n))
            if collected.last == 10 { break }
        }
        let request = (try? JSONSerialization.jsonObject(with: collected)) as? [String:Any]
        let result: [String:Any]
        if let request {
            let sem = DispatchSemaphore(value: 0)
            var value: [String:Any] = [:]
            Task {
                value = await execute(request)
                sem.signal()
            }
            sem.wait()
            result = value
        } else {
            result = ["error":"invalid_request"]
        }
        if let json = try? JSONSerialization.data(withJSONObject: result) {
            json.withUnsafeBytes { raw in
                if let base = raw.baseAddress {
                    var offset = 0
                    while offset < raw.count {
                        let n = write(client, base.advanced(by: offset), raw.count - offset)
                        if n <= 0 { break }
                        offset += n
                    }
                }
            }
        }
        close(client)
    }
}
