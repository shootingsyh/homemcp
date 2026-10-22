import Foundation
import Security

// JSON protocol over stdin/stdout. Never pass credentials in process arguments.
struct Request: Codable {
    let operation: String
    let binding: String
    let data: String
}
struct Response: Codable { let data: String?; let error: String? }
func emit(_ response: Response) {
    let encoded = try! JSONEncoder().encode(response)
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data([10]))
}
func itemQuery(_ identifier: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "HomeMCP.WebsiteCredentials.v1",
     kSecAttrAccount as String: identifier]
}
func execute(_ request: Request) throws -> Data {
    guard let binding = Data(base64Encoded: request.binding),
          let input = Data(base64Encoded: request.data) else {
        throw NSError(domain: "HomeMCP", code: 1)
    }
    if request.operation == "protect" {
        let identifier = UUID().uuidString
        var query = itemQuery(identifier)
        query[kSecValueData as String] = input
        query[kSecAttrGeneric as String] = binding
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: "Keychain", code: Int(status)) }
        return Data(identifier.utf8)
    }
    if request.operation == "unprotect" {
        guard let identifier = String(data: input, encoding: .utf8),
              identifier.count <= 64 else { throw NSError(domain: "HomeMCP", code: 2) }
        var query = itemQuery(identifier)
        query[kSecReturnAttributes as String] = true
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let item = result as? [String: Any],
              let storedBinding = item[kSecAttrGeneric as String] as? Data,
              storedBinding == binding,
              let secret = item[kSecValueData as String] as? Data else {
            throw NSError(domain: "Keychain", code: Int(status))
        }
        return secret
    }
    throw NSError(domain: "HomeMCP", code: 3)
}
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let request = try JSONDecoder().decode(Request.self, from: input)
    let result = try execute(request)
    emit(Response(data: result.base64EncodedString(), error: nil))
} catch {
    emit(Response(data: nil, error: "keychain_operation_failed"))
    exit(1)
}
