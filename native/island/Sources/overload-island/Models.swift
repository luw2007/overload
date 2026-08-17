import Foundation

struct Summary: Decodable, Equatable {
    let q1: Int
    let q2: Int
    let openIncidents: Int
    let coverageGaps: Int
    let telemetryGaps: Int

    enum CodingKeys: String, CodingKey {
        case q1, q2
        case openIncidents = "open_incidents"
        case coverageGaps = "coverage_gaps"
        case telemetryGaps = "telemetry_gaps"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        q1 = try values.decodeIfPresent(Int.self, forKey: .q1) ?? 0
        q2 = try values.decodeIfPresent(Int.self, forKey: .q2) ?? 0
        openIncidents = try values.decodeIfPresent(Int.self, forKey: .openIncidents) ?? 0
        coverageGaps = try values.decodeIfPresent(Int.self, forKey: .coverageGaps) ?? 0
        telemetryGaps = try values.decodeIfPresent(Int.self, forKey: .telemetryGaps) ?? 0
    }

    var isHealthy: Bool {
        openIncidents == 0 && coverageGaps == 0 && telemetryGaps == 0
    }
}

struct Q1Row: Decodable, Identifiable, Equatable {
    let requestUID: String
    let stableID: String
    let host: String?
    let kind: String?
    let detail: JSONDetail?
    let binding: String?

    var id: String { requestUID }

    enum CodingKeys: String, CodingKey {
        case requestUID = "request_uid"
        case stableID = "stable_id"
        case host, kind, detail, binding
    }

    var displayText: String {
        if let detail {
            for key in ["summary", "question", "message", "prompt"] {
                if let text = detail.stringValues[key], !text.isEmpty { return text }
            }
        }
        return kind ?? requestUID
    }

    var metaText: String {
        [host, stableID].compactMap { value in
            guard let value, !value.isEmpty else { return nil }
            return value
        }.joined(separator: " · ")
    }

    var copyBinding: String { binding.flatMap { $0.isEmpty ? nil : $0 } ?? "无跳转标识" }
}

/// `detail` on the wire is a real JSON object (`Record<string, unknown> | null`
/// per `src/shared/queries.ts`'s `withParsedDetail`, serialized as-is by
/// `Response.json()`) — not a JSON-encoded string. Decode it generically and
/// keep only the string-valued keys we actually read (`displayText` above).
struct JSONDetail: Decodable, Equatable {
    let stringValues: [String: String]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicKey.self)
        var values: [String: String] = [:]
        for key in container.allKeys {
            if let text = try? container.decode(String.self, forKey: key) { values[key.stringValue] = text }
        }
        stringValues = values
    }
}

private struct DynamicKey: CodingKey {
    var stringValue: String
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue: Int) { return nil }
}

enum APIModels {
    private struct Q1Envelope: Decodable { let rows: [Q1Row] }

    static func decodeQ1(_ data: Data) throws -> [Q1Row] {
        let decoder = JSONDecoder()
        if let rows = try? decoder.decode([Q1Row].self, from: data) { return rows }
        return try decoder.decode(Q1Envelope.self, from: data).rows
    }
}

enum WebConfiguration {
    static let defaultPort = 4870

    static func webPort(from data: Data?) -> Int {
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = json["web_port"] as? Int,
              (1...65_535).contains(port) else { return defaultPort }
        return port
    }

    static func loadWebPort(fileManager: FileManager = .default) -> Int {
        let url = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent(".overload/config.json")
        return webPort(from: try? Data(contentsOf: url))
    }
}
