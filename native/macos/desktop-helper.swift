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
        let granted = CGRequestScreenCaptureAccess()
        return ["screen_recording": granted, "permission_subject": "HomeMCP.Desktop", "restart_may_be_required": !granted]
    }
    if name=="desktop_screenshot" {
        guard CGPreflightScreenCaptureAccess() else {return ["error":"screen_recording_permission_required","permission_subject":"HomeMCP.Desktop","next_step":"Use Request Screen Recording in HomeMCP Manager, then enable the displayed HomeMCP component in System Settings > Privacy & Security > Screen & System Audio Recording. Restart the Host if macOS asks."]}
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
let data = FileHandle.standardInput.readDataToEndOfFile()
if let input = try? JSONSerialization.jsonObject(with: data) as? [String:Any] {
    Task {
        send(await execute(input))
        exit(0)
    }
    dispatchMain()
} else {
    send(["error":"invalid_request"])
}
