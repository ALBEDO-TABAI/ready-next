// The startup splash's native layers (plan docs/superpowers/plans/2026-11-19-ready-next-startup-splash-implementation.md
// §6), under the page of a transparent window: the system's clear Liquid Glass (NSGlassEffectView) for the slab, and
// below it the water (ripple-core.h) — the desktop behind the window pushed into ripples, then magnified at the rim —
// which the glass bends again with its own rounded rim. attach / calm / clear; Main loads it (src/main/startup-glass.ts).
#include <node_api.h>
#import <AppKit/AppKit.h>
#include "ripple-core.h"

static NSMutableArray<NSView *> *gViews;
static NSMutableArray<CALayer *> *gCovers;
static CGFloat gWidth;

static double num(napi_env env, napi_value v) { double out = 0; napi_get_value_double(env, v, &out); return out; }
static napi_value text(napi_env env, NSString *s) { napi_value v; napi_create_string_utf8(env, s.UTF8String, NAPI_AUTO_LENGTH, &v); return v; }

// attach(handle, x, y, w, h, radius, amount[, edgeAmount])
static napi_value Attach(napi_env env, napi_callback_info info) {
  size_t argc = 8; napi_value argv[8]; napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL; size_t length = 0;
  if (argc < 7 || napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) return text(env, @"bad arguments");
  NSView *host = (__bridge NSView *)(*(void **)data);
  double x = num(env, argv[1]), y = num(env, argv[2]), w = num(env, argv[3]), h = num(env, argv[4]), radius = num(env, argv[5]), amount = num(env, argv[6]);
  double edgeAmount = argc > 7 ? num(env, argv[7]) : 200;
  CGFloat scale = host.window.backingScaleFactor > 0 ? host.window.backingScaleFactor : 2;
  NSRect frame = NSMakeRect(x, host.isFlipped ? y : host.bounds.size.height - y - h, w, h);
  NSMutableString *log = [NSMutableString string];
  gViews = [NSMutableArray array]; gCovers = [NSMutableArray array]; gWidth = w;
  if (@available(macOS 26.0, *)) {
    NSGlassEffectView *glass = [[NSGlassEffectView alloc] initWithFrame:frame];
    glass.cornerRadius = radius; glass.style = NSGlassEffectViewStyleClear;
    [host addSubview:glass positioned:NSWindowBelow relativeTo:nil];
    [gViews addObject:glass]; [log appendString:@"glass "];
  }
  @try {
    if (NSClassFromString(@"CABackdropLayer") && NSClassFromString(@"CAFilter")) {
      NSView *water = [[NSView alloc] initWithFrame:frame];
      CALayer *rootLayer = [CALayer layer]; rootLayer.geometryFlipped = YES;
      water.layer = rootLayer; water.wantsLayer = YES;
      RippleSource sources[] = {
        { -520, 40, 88, 5.6, 0.4, 1.0, 2 },
        { -260, 250, 104, 4.3, 2.1, 0.75, 2 },
        { -900, 120, 80, 7.1, 4.6, 0.9, 2 },
        { -380, -120, 96, 6.3, 3.3, 0.7, 1 },
      };
      [CATransaction begin]; [CATransaction setDisableActions:YES];
      CALayer *backdrop = rippleBackdrop(CGSizeMake(w, h), radius, sources, 4, amount, CACurrentMediaTime(), gCovers, YES, edgeAmount, scale, NO);
      [rootLayer addSublayer:backdrop];
      [CATransaction commit];
      // under the glass: the desktop is pushed into ripples first, then the glass bends that with its own rounded rim
      [host addSubview:water positioned:NSWindowBelow relativeTo:gViews.firstObject];
      [gViews addObject:water]; [log appendString:@"ripples"];
    }
  } @catch (NSException *e) { [log appendFormat:@"ripples failed: %@", e.reason]; }
  return text(env, log);
}

// calm(seconds): from left to right the water goes still.
static napi_value Calm(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  calmRipples(gCovers, gWidth, CACurrentMediaTime() + 0.02, argc ? num(env, argv[0]) : 1.2);
  return text(env, @"calm");
}

static napi_value Clear(napi_env env, napi_callback_info info) {
  for (NSView *v in gViews) [v removeFromSuperview];
  [gViews removeAllObjects]; [gCovers removeAllObjects];
  return text(env, @"clear");
}

NAPI_MODULE_INIT() {
  struct { const char *name; napi_callback fn; } list[] = { {"attach", Attach}, {"calm", Calm}, {"clear", Clear} };
  for (auto &item : list) { napi_value fn; napi_create_function(env, item.name, NAPI_AUTO_LENGTH, item.fn, NULL, &fn); napi_set_named_property(env, exports, item.name, fn); }
  return exports;
}
