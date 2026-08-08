// SpeechRecognizer — macOS 本地语音识别 helper
// 协议：stdout 每行一个 JSON 事件
//   {"type":"ready"}                      开始收音
//   {"type":"partial","text":"…"}        实时中间结果
//   {"type":"final","text":"…"}          最终结果
//   {"type":"error","message":"…"}       出错（随后退出）
// stdin 收到 "stop" 行（或 SIGTERM/60s 超时）后结束音频并输出最终结果。
// 编译：见 package.json build:speech

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

static void emitJSON(NSDictionary *payload) {
  @autoreleasepool {
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    if (!data) return;
    NSMutableData *line = [NSMutableData dataWithData:data];
    [line appendBytes:"\n" length:1];
    [[NSFileHandle fileHandleWithStandardOutput] writeData:line];
  }
}

static void emitError(NSString *message) {
  emitJSON(@{ @"type" : @"error", @"message" : message ?: @"语音识别失败" });
}

@interface SpeechSession : NSObject
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, assign) BOOL finished;
- (BOOL)start;
- (void)stopAudio;
- (void)finishWithText:(NSString *)text;
@end

@implementation SpeechSession

- (BOOL)start {
  NSLocale *locale = [NSLocale localeWithLocaleIdentifier:@"zh-CN"];
  self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
  if (!self.recognizer || !self.recognizer.isAvailable) {
    emitError(@"当前系统语音识别不可用，请在系统设置中开启「听写」或键盘语音输入");
    return NO;
  }

  self.request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
  self.request.shouldReportPartialResults = YES;
  if (@available(macOS 10.15, *)) {
    if (self.recognizer.supportsOnDeviceRecognition) {
      self.request.requiresOnDeviceRecognition = YES;
    }
  }

  self.engine = [[AVAudioEngine alloc] init];
  AVAudioInputNode *input = self.engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  if (format.channelCount == 0) {
    emitError(@"没有检测到可用麦克风");
    return NO;
  }

  __weak SpeechSession *weakSelf = self;
  [input installTapOnBus:0
              bufferSize:2048
                  format:format
                   block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                     [weakSelf.request appendAudioPCMBuffer:buffer];
                   }];

  self.task = [self.recognizer
      recognitionTaskWithRequest:self.request
                   resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
                     SpeechSession *strongSelf = weakSelf;
                     if (!strongSelf || strongSelf.finished) return;
                     if (result) {
                       NSString *text = result.bestTranscription.formattedString ?: @"";
                       if (result.isFinal) {
                         [strongSelf finishWithText:text];
                         return;
                       }
                       emitJSON(@{ @"type" : @"partial", @"text" : text });
                     }
                     if (error) {
                       // endAudio 之后系统会以 error 或 final 收尾；这里只在还没结束时报错
                       [strongSelf stopAudio];
                       strongSelf.finished = YES;
                       emitError(error.localizedDescription ?: @"语音识别失败");
                       exit(1);
                     }
                   }];

  NSError *engineError = nil;
  [self.engine prepare];
  if (![self.engine startAndReturnError:&engineError]) {
    emitError(engineError.localizedDescription ?: @"无法启动麦克风");
    return NO;
  }
  emitJSON(@{ @"type" : @"ready" });
  return YES;
}

- (void)stopAudio {
  if (self.engine.isRunning) {
    [self.engine.inputNode removeTapOnBus:0];
    [self.engine stop];
  }
  [self.request endAudio];
}

- (void)finishWithText:(NSString *)text {
  if (self.finished) return;
  self.finished = YES;
  [self stopAudio];
  emitJSON(@{ @"type" : @"final", @"text" : text ?: @"" });
  exit(0);
}

@end

static SpeechSession *gSession = nil;

static void requestStop(void) {
  static BOOL requested = NO;
  if (requested) return;
  requested = YES;
  dispatch_async(dispatch_get_main_queue(), ^{
    [gSession stopAudio];
    // endAudio 后给识别器最多 5 秒收尾；超时按当前结果退出
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      [gSession finishWithText:@""];
    });
  });
}

int main(void) {
  @autoreleasepool {
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
          emitError(@"语音识别未授权，请在 系统设置 → 隐私与安全性 → 语音识别 中允许");
          exit(1);
        }
        gSession = [[SpeechSession alloc] init];
        if (![gSession start]) exit(1);
      });
    }];

    // stdin：收到 stop 或 EOF 即结束
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      char buffer[128];
      while (fgets(buffer, sizeof(buffer), stdin)) {
        if (strncmp(buffer, "stop", 4) == 0) break;
      }
      requestStop();
    });

    signal(SIGTERM, SIG_IGN);
    dispatch_source_t sigterm = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(sigterm, ^{ requestStop(); });
    dispatch_resume(sigterm);

    // 兜底：最长收音 60 秒
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      requestStop();
    });

    dispatch_main();
  }
  return 0;
}
