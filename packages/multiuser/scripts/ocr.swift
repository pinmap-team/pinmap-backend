import Foundation
import Vision
let paths=Array(CommandLine.arguments.dropFirst())
for path in paths {
 do {
  let request=VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages=["ko-KR","en-US"]
  request.usesLanguageCorrection=false
  try VNImageRequestHandler(url:URL(fileURLWithPath:path)).perform([request])
  let rows=(request.results ?? []).compactMap { obs -> [String:Any]? in
   guard let text=obs.topCandidates(1).first else{return nil}
   return ["text":text.string,"confidence":text.confidence]
  }
  let data=try JSONSerialization.data(withJSONObject:["path":path,"lines":rows],options:[.sortedKeys])
  print(String(data:data,encoding:.utf8)!)
 }catch{let data=try! JSONSerialization.data(withJSONObject:["path":path,"error":error.localizedDescription]);print(String(data:data,encoding:.utf8)!)}
}
