#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>

static void fail(NSString *message) {
    NSData *data = [[message stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    [[NSFileHandle fileHandleWithStandardError] writeData:data];
    exit(1);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 4) fail(@"用法：VisionSegmenter <输入图片> <蒙版 PNG> <分析 JSON>");

        NSURL *inputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
        NSURL *maskURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[2]]];
        NSURL *jsonURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[3]]];

        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)inputURL, NULL);
        if (!source) fail(@"无法读取输入图片");
        CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
        CFRelease(source);
        if (!image) fail(@"无法解码输入图片");

        VNGenerateForegroundInstanceMaskRequest *foregroundRequest = [VNGenerateForegroundInstanceMaskRequest new];
        VNRecognizeTextRequest *textRequest = [VNRecognizeTextRequest new];
        textRequest.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        textRequest.usesLanguageCorrection = NO;
        textRequest.minimumTextHeight = 0.012;
        textRequest.recognitionLanguages = @[@"zh-Hans", @"zh-Hant", @"en-US"];

        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
        NSError *error = nil;
        if (![handler performRequests:@[foregroundRequest, textRequest] error:&error]) {
            CGImageRelease(image);
            fail(error.localizedDescription ?: @"Vision 图片分析失败");
        }

        VNInstanceMaskObservation *observation = foregroundRequest.results.firstObject;
        NSUInteger instanceCount = observation ? observation.allInstances.count : 0;
        CVPixelBufferRef maskBuffer = NULL;
        if (instanceCount > 0) {
            maskBuffer = [observation generateScaledMaskForImageForInstances:observation.allInstances
                                                           fromRequestHandler:handler
                                                                        error:&error];
        } else {
            CVReturn status = CVPixelBufferCreate(
                kCFAllocatorDefault,
                CGImageGetWidth(image),
                CGImageGetHeight(image),
                kCVPixelFormatType_OneComponent8,
                NULL,
                &maskBuffer
            );
            if (status == kCVReturnSuccess && maskBuffer) {
                CVPixelBufferLockBaseAddress(maskBuffer, 0);
                memset(CVPixelBufferGetBaseAddress(maskBuffer), 0, CVPixelBufferGetBytesPerRow(maskBuffer) * CVPixelBufferGetHeight(maskBuffer));
                CVPixelBufferUnlockBaseAddress(maskBuffer, 0);
            }
        }
        if (!maskBuffer) {
            CGImageRelease(image);
            fail(error.localizedDescription ?: @"主体蒙版生成失败");
        }

        CIImage *maskImage = [CIImage imageWithCVPixelBuffer:maskBuffer];
        CIContext *context = [CIContext contextWithOptions:@{kCIContextCacheIntermediates: @NO}];
        CGColorSpaceRef gray = CGColorSpaceCreateDeviceGray();
        BOOL wroteMask = [context writePNGRepresentationOfImage:maskImage
                                                          toURL:maskURL
                                                         format:kCIFormatL8
                                                     colorSpace:gray
                                                        options:@{}
                                                          error:&error];
        CGColorSpaceRelease(gray);
        CVPixelBufferRelease(maskBuffer);
        if (!wroteMask) {
            CGImageRelease(image);
            fail(error.localizedDescription ?: @"主体蒙版写入失败");
        }

        NSMutableArray *regions = [NSMutableArray array];
        for (VNRecognizedTextObservation *item in textRequest.results ?: @[]) {
            VNRecognizedText *candidate = [item topCandidates:1].firstObject;
            if (!candidate || candidate.confidence < 0.25) continue;
            CGRect box = item.boundingBox;
            [regions addObject:@{
                @"x": @(CGRectGetMinX(box)),
                @"y": @(1.0 - CGRectGetMaxY(box)),
                @"width": @(CGRectGetWidth(box)),
                @"height": @(CGRectGetHeight(box)),
                @"confidence": @(candidate.confidence),
                @"text": candidate.string ?: @""
            }];
        }

        NSDictionary *result = @{
            @"instanceCount": @(instanceCount),
            @"textRegions": regions
        };
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:&error];
        CGImageRelease(image);
        if (!json || ![json writeToURL:jsonURL options:NSDataWritingAtomic error:&error]) {
            fail(error.localizedDescription ?: @"分析结果写入失败");
        }
    }
    return 0;
}
