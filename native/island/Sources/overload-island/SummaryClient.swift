import Foundation

@MainActor
final class SummaryClient {
    private let baseURL: URL
    private let session: URLSession

    init(port: Int = WebConfiguration.loadWebPort(), session: URLSession = .shared) {
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        self.session = session
    }

    func fetchSummary(completion: @escaping (Result<Summary, Error>) -> Void) {
        fetch(path: "/api/summary") { dataResult in
            completion(dataResult.flatMap { data in Result { try JSONDecoder().decode(Summary.self, from: data) } })
        }
    }

    func fetchQ1(completion: @escaping (Result<[Q1Row], Error>) -> Void) {
        fetch(path: "/api/q1") { dataResult in
            completion(dataResult.flatMap { data in Result { try APIModels.decodeQ1(data) } })
        }
    }

    private func fetch(path: String, completion: @escaping (Result<Data, Error>) -> Void) {
        let request = URLRequest(url: baseURL.appendingPathComponent(path),
                                 cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: 3)
        session.dataTask(with: request) { data, response, error in
            let result: Result<Data, Error>
            if let error {
                result = .failure(error)
            } else if let response = response as? HTTPURLResponse,
                      (200..<300).contains(response.statusCode), let data {
                result = .success(data)
            } else {
                result = .failure(URLError(.badServerResponse))
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }
}
