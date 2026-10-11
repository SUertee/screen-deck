import Foundation

/// Provider metadata only. Credentials are references, never API keys or passwords.
struct LLMProviderConfig: Codable, Equatable, Sendable, Identifiable {
    var id: String { providerID }
    let providerID: String
    let name: String
    let models: [ModelDescriptor]
    let defaultModelID: String?
    let credentialReference: String?

    init(providerID: String, name: String, models: [ModelDescriptor], defaultModelID: String? = nil, credentialReference: String? = nil) {
        self.providerID = providerID; self.name = name; self.models = models
        self.defaultModelID = defaultModelID; self.credentialReference = credentialReference
    }

    enum CodingKeys: String, CodingKey {
        case providerID = "provider_id", name, models
        case defaultModelID = "default_model_id", credentialReference = "credential_reference"
    }
}

struct ModelDescriptor: Codable, Equatable, Sendable, Identifiable {
    var id: String { modelID }
    let modelID: String
    let name: String
    let variants: [String]
    init(modelID: String, name: String, variants: [String] = []) {
        self.modelID = modelID; self.name = name; self.variants = variants
    }
    enum CodingKeys: String, CodingKey { case modelID = "model_id", name, variants }
}

struct ModelSelection: Codable, Equatable, Hashable, Sendable {
    let providerID: String
    let modelID: String
    let variant: String?
    init(providerID: String, modelID: String, variant: String? = nil) {
        self.providerID = providerID; self.modelID = modelID; self.variant = variant
    }
    enum CodingKeys: String, CodingKey { case providerID = "provider_id", modelID = "model_id", variant }
}
