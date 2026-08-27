#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

static void finish(BOOL ok, NSString *text, NSString *error, NSString *code, int status) {
  NSMutableDictionary *response = [NSMutableDictionary dictionaryWithObject:@(ok) forKey:@"ok"];
  if (text) response[@"text"] = text;
  if (error) response[@"error"] = error;
  if (code) response[@"code"] = code;
  NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fwrite("\n", 1, 1, stdout);
  exit(status);
}

static BOOL runUntil(BOOL *completed, NSTimeInterval timeout) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!*completed && deadline.timeIntervalSinceNow > 0) {
    @autoreleasepool {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
  }
  return *completed;
}

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    if (argc != 2) finish(NO, nil, @"Expected one WAV file path", @"invalid-arguments", 2);

    __block SFSpeechRecognizerAuthorizationStatus permission = SFSpeechRecognizerAuthorizationStatusNotDetermined;
    __block BOOL permissionResolved = NO;
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
      permission = status;
      permissionResolved = YES;
    }];
    runUntil(&permissionResolved, 20);
    if (permission != SFSpeechRecognizerAuthorizationStatusAuthorized) {
      NSString *code = @"permission-unknown";
      if (permission == SFSpeechRecognizerAuthorizationStatusDenied) code = @"permission-denied";
      else if (permission == SFSpeechRecognizerAuthorizationStatusRestricted) code = @"permission-restricted";
      else if (permission == SFSpeechRecognizerAuthorizationStatusNotDetermined) code = @"permission-not-determined";
      finish(NO, nil, @"macOS Speech Recognition permission is required", code, 3);
    }

    SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] init];
    if (!recognizer || !recognizer.available) {
      finish(NO, nil, @"Speech recognition is currently unavailable", @"recognizer-unavailable", 4);
    }
    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    SFSpeechURLRecognitionRequest *request = [[SFSpeechURLRecognitionRequest alloc] initWithURL:url];
    request.shouldReportPartialResults = NO;
    if (@available(macOS 13.0, *)) request.addsPunctuation = YES;

    __block NSString *recognized = nil;
    __block NSError *recognitionError = nil;
    __block BOOL signaled = NO;
    SFSpeechRecognitionTask *task = [recognizer recognitionTaskWithRequest:request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
      if (signaled) return;
      if (error || result.final) {
        signaled = YES;
        recognitionError = error;
        recognized = result.bestTranscription.formattedString;
      }
    }];
    if (!runUntil(&signaled, 40)) {
      [task cancel];
      finish(NO, nil, @"Speech recognition timed out", @"timeout", 5);
    }
    if (recognitionError) finish(NO, nil, recognitionError.localizedDescription, @"recognition-error", 6);
    finish(YES, recognized ?: @"", nil, nil, 0);
  }
}
