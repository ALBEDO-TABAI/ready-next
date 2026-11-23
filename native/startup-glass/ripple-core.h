// The water under the startup splash's glass (plan docs/superpowers/plans/2026-11-19-ready-next-startup-splash-implementation.md
// §6). Ripples from far-away stones left of the slab cross it from left to right: each stone's wave packets are radial
// gradients (their colour is the push: red = across, green = up/down, 0.5 = none; blue = 1, take the pushed picture
// fully) in one map, read by one displacementMap filter on a backdrop layer that holds the desktop behind the window.
// A second, still map is the rim lens: it magnifies the picture just inside the rim, like thick bevelled glass. Every
// motion is Core Animation in the render server, so a busy main thread does not stop the water.
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#include <math.h>
#include <vector>

struct RippleSource { double x, y, speed, period, phase, amplitude; int drops; };

static double rhash(double seed) { double v = sin(seed * 127.1 + 311.7) * 43758.5453; return v - floor(v); }
// Blue is how much of the pushed picture replaces the original: 1 = all of it. (0.5 showed it at half strength,
// darkening the glass grey in the real window.)
static CGColorRef grey(double r, double g, double a) { return CGColorCreateSRGB(r, g, 1.0, a); }

static id caFilter(NSString *type, NSString *name) {
  id f = ((id (*)(id, SEL, id))objc_msgSend)(NSClassFromString(@"CAFilter"), @selector(filterWithType:), type);
  [f setValue:name forKey:@"name"];
  return f;
}

// One drop: a radial gradient as big as the farthest point it reaches; its wave packet (three crests or so) is a band
// of stops whose locations travel outward. lambda and sigma in points.
static CAGradientLayer *dropLayer(CGSize size, CGPoint centre, double reach, double angle, double lambda, double sigma, double start, double end,
                                  CFTimeInterval begin, CFTimeInterval travel, CFTimeInterval period, double amplitude) {
  CAGradientLayer *g = [CAGradientLayer layer];
  g.type = kCAGradientLayerRadial;
  // as big as the slab only (a layer thousands of points wide is not drawn); the centre lies outside it
  g.frame = CGRectMake(0, 0, size.width, size.height);
  g.startPoint = CGPointMake(centre.x / size.width, centre.y / size.height);
  g.endPoint = CGPointMake((centre.x + reach) / size.width, (centre.y + reach) / size.height);
  const int n = 41; double span = 3 * sigma;
  NSMutableArray *colors = [NSMutableArray array], *from = [NSMutableArray array], *to = [NSMutableArray array];
  CGColorRef clear = grey(0.5, 0.5, 0); [colors addObject:(__bridge id)clear]; [from addObject:@0]; [to addObject:@0];
  for (int j = 0; j < n; j++) {
    double off = -span + 2 * span * j / (n - 1);
    double envelope = exp(-(off * off) / (sigma * sigma)), wave = sin(2 * M_PI * off / lambda);
    CGColorRef c = grey(0.5 + 0.5 * wave * cos(angle), 0.5 + 0.5 * wave * sin(angle), (j == 0 || j == n - 1) ? 0 : envelope);
    [colors addObject:(__bridge id)c]; CGColorRelease(c);
    [from addObject:@(fmax(0.0001, fmin(0.9999, (start + off) / reach)))];
    [to addObject:@(fmax(0.0001, fmin(0.9999, (end + off) / reach)))];
  }
  [colors addObject:(__bridge id)clear]; [from addObject:@1]; [to addObject:@1]; CGColorRelease(clear);
  g.colors = colors; g.locations = from;
  CABasicAnimation *travelOut = [CABasicAnimation animationWithKeyPath:@"locations"];
  travelOut.fromValue = from; travelOut.toValue = to; travelOut.duration = travel;
  CAKeyframeAnimation *fade = [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
  fade.values = @[@0, @(amplitude), @(amplitude * 0.9), @0]; fade.keyTimes = @[@0, @0.08, @0.78, @1]; fade.duration = travel;
  CAAnimationGroup *drop = [CAAnimationGroup animation];
  drop.animations = @[travelOut, fade]; drop.duration = period; drop.repeatCount = HUGE_VALF; drop.beginTime = begin;
  g.opacity = 0;
  [g addAnimation:drop forKey:@"ripple"];
  return g;
}

// The edge lens: a picture of how far to push near the rim of a rounded rectangle — inward, so the rim magnifies
// what lies just inside it, like the raised, bevelled edge of thick glass; strongest at the rim and fading to nothing
// about `reach` points in. (Outward does not work: the backdrop only sees what lies inside the slab.) The fall-off is
// gentle enough that the picture is stretched at the rim but never folds over. `slab` is the rectangle inside an image of `size` points; `scale` pixels per point.
static CGImageRef edgeLensImage(CGSize size, CGRect slab, double radius, double reach, double scale, BOOL flipRows) {
  size_t w = (size_t)ceil(size.width * scale), h = (size_t)ceil(size.height * scale);
  std::vector<uint8_t> px(w * h * 4);
  double cx = CGRectGetMidX(slab), cy = CGRectGetMidY(slab), hx = slab.size.width / 2 - radius, hy = slab.size.height / 2 - radius;
  for (size_t j = 0; j < h; j++) for (size_t i = 0; i < w; i++) {
    double x = (i + 0.5) / scale, y = (j + 0.5) / scale, dx = x - cx, dy = y - cy;
    double qx = fabs(dx) - hx, qy = fabs(dy) - hy, nx, ny, inside;
    if (qx > 0 && qy > 0) { double l = hypot(qx, qy); nx = qx / l; ny = qy / l; inside = radius - l; }
    else if (qx > qy) { nx = 1; ny = 0; inside = radius - qx; }
    else { nx = 0; ny = 1; inside = radius - qy; }
    nx = dx < 0 ? -nx : nx; ny = dy < 0 ? -ny : ny;
    double f = pow(1 - fmin(1, fmax(0, inside / reach)), 2.4);
    size_t row = flipRows ? h - 1 - j : j;
    uint8_t *p = &px[(row * w + i) * 4];
    // BGRA, premultiplied, opaque: red = across, green = up/down, blue = 1 (take the pushed picture fully)
    p[0] = 255; p[1] = (uint8_t)lround(255 * (0.5 - 0.5 * ny * f)); p[2] = (uint8_t)lround(255 * (0.5 - 0.5 * nx * f)); p[3] = 255;
  }
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(px.data(), w, h, 8, w * 4, cs, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGImageRef image = CGBitmapContextCreateImage(ctx);
  CGContextRelease(ctx); CGColorSpaceRelease(cs);
  return image;
}

// The backdrop layer over the slab with one map + filter per source. size: the slab in points; cover: the calm cover per map.
static CALayer *rippleBackdrop(CGSize size, double radius, const RippleSource *sources, int count, double amount, CFTimeInterval t0,
                               NSMutableArray<CALayer *> *covers, BOOL windowServerAware, double edgeAmount = 0, double scale = 2, BOOL flipEdgeRows = NO) {
  // the backdrop reaches a little past the slab, so the rim can show what lies just beyond it; the slab clips it
  const double margin = edgeAmount > 0 ? 26 : 0;
  CALayer *slab = [CALayer layer]; slab.frame = CGRectMake(0, 0, size.width, size.height);
  slab.cornerRadius = radius; slab.masksToBounds = YES;
  CALayer *backdrop = [NSClassFromString(@"CABackdropLayer") layer];
  backdrop.frame = CGRectMake(-margin, -margin, size.width + 2 * margin, size.height + 2 * margin);
  [slab addSublayer:backdrop];
  [backdrop setValue:@(windowServerAware) forKey:@"windowServerAware"];
  [backdrop setValue:@1.0 forKey:@"scale"];
  CALayer *map = [CALayer layer]; map.name = @"map"; map.frame = CGRectMake(margin, margin, size.width, size.height); map.masksToBounds = YES;
  CGColorRef base = grey(0.5, 0.5, 1); map.backgroundColor = base; CGColorRelease(base);
  for (int k = 0; k < count; k++) {
    const RippleSource &s = sources[k];
    CGPoint centre = CGPointMake(s.x, s.y);
    double nearest = hypot(fmax(0, -s.x), s.y < 0 ? -s.y : s.y > size.height ? s.y - size.height : 0);
    double farthest = fmax(hypot(size.width - s.x, s.y), hypot(size.width - s.x, size.height - s.y));
    double reach = farthest + 140, start = fmax(0, nearest - 110), end = farthest + 110;
    double angle = atan2(size.height / 2 - s.y, size.width / 2 - s.x);
    CFTimeInterval travel = (end - start) / s.speed;
    for (int d = 0; d < s.drops; d++) {
      double lambda = 52 + rhash(k * 7.1 + d) * 30, sigma = 64 + rhash(k * 3.3 + d) * 30;
      CFTimeInterval begin = t0 - s.phase + d * s.period / s.drops;
      [map addSublayer:dropLayer(size, centre, reach, angle, lambda, sigma, start, end, begin, travel, fmax(travel, s.period), s.amplitude)];
    }
  }
  // the calm: a cover of "no push" with a soft leading edge, waiting left of the slab
  double edge = 170;
  CAGradientLayer *cover = [CAGradientLayer layer];
  cover.frame = CGRectMake(-(size.width + edge), 0, size.width + edge, size.height);
  cover.startPoint = CGPointMake(0, 0.5); cover.endPoint = CGPointMake(1, 0.5);
  CGColorRef solid = grey(0.5, 0.5, 1), none = grey(0.5, 0.5, 0);
  cover.colors = @[(__bridge id)solid, (__bridge id)solid, (__bridge id)none]; cover.locations = @[@0, @(size.width / (size.width + edge)), @1];
  CGColorRelease(solid); CGColorRelease(none);
  [map addSublayer:cover]; [covers addObject:cover];
  [backdrop addSublayer:map];
  id f = caFilter(@"displacementMap", @"ripple");
  [f setValue:@"map" forKey:@"inputSourceSublayerName"];
  [f setValue:@(amount) forKey:@"inputAmount"];
  [f setValue:[NSValue valueWithPoint:NSMakePoint(0.5, 0.5)] forKey:@"inputOffset"];
  NSMutableArray *filters = [NSMutableArray arrayWithObject:f];
  if (edgeAmount > 0) {
    CALayer *edge = [CALayer layer]; edge.name = @"edge"; edge.frame = backdrop.bounds; edge.contentsScale = scale;
    CGImageRef lens = edgeLensImage(backdrop.bounds.size, CGRectMake(margin, margin, size.width, size.height), radius, 44, scale, flipEdgeRows);
    edge.contents = (__bridge id)lens; CGImageRelease(lens);
    [backdrop addSublayer:edge];
    id lensFilter = caFilter(@"displacementMap", @"edge");
    [lensFilter setValue:@"edge" forKey:@"inputSourceSublayerName"];
    [lensFilter setValue:@(edgeAmount) forKey:@"inputAmount"];
    [lensFilter setValue:[NSValue valueWithPoint:NSMakePoint(0.5, 0.5)] forKey:@"inputOffset"];
    [filters addObject:lensFilter];
  }
  backdrop.filters = filters;
  return slab;
}

// Calm from left to right: every cover slides over its map; afterwards nothing pushes.
static void calmRipples(NSArray<CALayer *> *covers, CGFloat width, CFTimeInterval at, CFTimeInterval duration) {
  for (CALayer *cover in covers) {
    CABasicAnimation *slide = [CABasicAnimation animationWithKeyPath:@"transform.translation.x"];
    slide.fromValue = @0; slide.toValue = @(width + 170); slide.beginTime = at; slide.duration = duration;
    slide.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.45 :0 :0.2 :1];
    slide.fillMode = kCAFillModeBoth; slide.removedOnCompletion = NO;
    [cover addAnimation:slide forKey:@"calm"];
  }
}
