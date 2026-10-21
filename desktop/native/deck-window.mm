#include <node_api.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <cmath>
#include <cstdint>
#include <cstring>

// All coordinates crossing this boundary are logical points/DIP in Electron's
// global top-left coordinate system. Cocoa uses a global bottom-left system.
// NSScreen.mainScreen follows the key window; screens[0] is the zero screen.
static CGFloat PrimaryTop(void) {
  NSArray<NSScreen *> *screens = [NSScreen screens];
  const CGDirectDisplayID primaryID = CGMainDisplayID();
  for (NSScreen *screen in screens) {
    NSNumber *identifier = screen.deviceDescription[@"NSScreenNumber"];
    if (identifier && identifier.unsignedIntValue == primaryID) return NSMaxY(screen.frame);
  }
  return screens.count ? NSMaxY(screens.firstObject.frame) : 0;
}

static napi_value Number(napi_env env, double value) {
  napi_value result; napi_create_double(env, value, &result); return result;
}
static napi_value JSBoolean(napi_env env, bool value) {
  napi_value result; napi_get_boolean(env, value, &result); return result;
}
static napi_value String(napi_env env, NSString *value) {
  napi_value result; napi_create_string_utf8(env, value.UTF8String, NAPI_AUTO_LENGTH, &result); return result;
}
static void Set(napi_env env, napi_value object, const char *name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}
static napi_value Rectangle(napi_env env, NSRect frame, CGFloat primaryTop) {
  napi_value result; napi_create_object(env, &result);
  Set(env, result, "x", Number(env, NSMinX(frame)));
  Set(env, result, "y", Number(env, primaryTop - NSMaxY(frame)));
  Set(env, result, "width", Number(env, NSWidth(frame)));
  Set(env, result, "height", Number(env, NSHeight(frame)));
  return result;
}
static napi_value OptionalRectangle(napi_env env, NSRect frame, CGFloat primaryTop) {
  if (!NSIsEmptyRect(frame)) return Rectangle(env, frame, primaryTop);
  napi_value result; napi_get_null(env, &result); return result;
}
static bool MainThread(napi_env env) {
  if ([NSThread isMainThread]) return true;
  napi_throw_error(env, "native-deck-thread", "Native Deck operations require the Electron main thread.");
  return false;
}
static napi_value Failure(napi_env env, NSException *exception) {
  // Exception internals and native addresses never cross into the renderer.
  (void)exception;
  napi_throw_error(env, "native-deck-failed", "The native Deck operation could not be completed.");
  return nullptr;
}

static napi_value GetDisplays(napi_env env, napi_callback_info info) {
  (void)info;
  if (!MainThread(env)) return nullptr;
  @autoreleasepool {
    @try {
      napi_value result; napi_create_array(env, &result);
      const CGFloat primaryTop = PrimaryTop();
      uint32_t index = 0;
      for (NSScreen *screen in [NSScreen screens]) {
        NSNumber *identifier = screen.deviceDescription[@"NSScreenNumber"];
        if (!identifier || identifier.unsignedIntValue == kCGNullDirectDisplay) continue;
        const CGDirectDisplayID displayID = identifier.unsignedIntValue;
        NSEdgeInsets safe = NSEdgeInsetsMake(0, 0, 0, 0);
        NSRect left = NSZeroRect, right = NSZeroRect;
        if (@available(macOS 12.0, *)) {
          safe = screen.safeAreaInsets;
          left = screen.auxiliaryTopLeftArea;
          right = screen.auxiliaryTopRightArea;
        }
        const CGFloat gap = NSMinX(right) - NSMaxX(left);
        const bool hasNotch = safe.top > 0 && safe.top <= NSHeight(screen.frame)
          && !NSIsEmptyRect(left) && !NSIsEmptyRect(right)
          && gap > 0 && gap < NSWidth(screen.frame);
        napi_value display, insets; napi_create_object(env, &display); napi_create_object(env, &insets);
        Set(env, display, "displayID", String(env, [NSString stringWithFormat:@"%u", displayID]));
        Set(env, display, "bounds", Rectangle(env, screen.frame, primaryTop));
        Set(env, display, "builtIn", JSBoolean(env, CGDisplayIsBuiltin(displayID) != 0));
        Set(env, display, "hasNotch", JSBoolean(env, hasNotch));
        Set(env, display, "notchWidth", Number(env, hasNotch ? gap : 0));
        Set(env, display, "notchHeight", Number(env, hasNotch ? safe.top : 0));
        Set(env, insets, "top", Number(env, safe.top));
        Set(env, insets, "left", Number(env, safe.left));
        Set(env, insets, "bottom", Number(env, safe.bottom));
        Set(env, insets, "right", Number(env, safe.right));
        Set(env, display, "safeAreaInsets", insets);
        Set(env, display, "auxiliaryTopLeftArea", OptionalRectangle(env, left, primaryTop));
        Set(env, display, "auxiliaryTopRightArea", OptionalRectangle(env, right, primaryTop));
        napi_set_element(env, result, index++, display);
      }
      return result;
    } @catch (NSException *exception) { return Failure(env, exception); }
  }
}

static napi_value GetMouseButtons(napi_env env, napi_callback_info info) {
  (void)info;
  if (!MainThread(env)) return nullptr;
  @autoreleasepool {
    @try {
      // Read-only current state, no event tap/monitor, accessibility API, event
      // contents, input-monitoring entitlement, or background listener.
      const uint32_t mask = static_cast<uint32_t>([NSEvent pressedMouseButtons] & UINT32_MAX);
      napi_value result; napi_create_uint32(env, mask, &result); return result;
    } @catch (NSException *exception) { return Failure(env, exception); }
  }
}

// Electron's documented macOS handle is NSView*, not NSWindow*. Do not cast and
// dereference the caller's bytes. Compare the address with live views owned by
// this NSApplication; only then use the matched view's window property.
static NSView *FindOwnedView(NSView *view, uintptr_t address, NSUInteger depth, NSUInteger *visited) {
  if (!view || depth > 64 || ++(*visited) > 10000) return nil;
  if (reinterpret_cast<uintptr_t>((__bridge void *)view) == address) return view;
  for (NSView *child in view.subviews) {
    NSView *found = FindOwnedView(child, address, depth + 1, visited);
    if (found) return found;
  }
  return nil;
}
static NSWindow *OwnedWindow(uintptr_t address) {
  if (!address || !NSApp) return nil;
  for (NSWindow *window in NSApp.windows) {
    NSUInteger visited = 0;
    NSView *view = FindOwnedView(window.contentView, address, 0, &visited);
    if (view && view.window == window) return view.window;
  }
  return nil;
}
static NSMapTable<NSWindow *, NSDictionary *> *originalWindows;
static void CaptureWindow(NSWindow *window) {
  if (!originalWindows) originalWindows = [NSMapTable weakToStrongObjectsMapTable];
  if ([originalWindows objectForKey:window]) return;
  [originalWindows setObject:@{
    @"style": @(window.styleMask), @"level": @(window.level), @"collection": @(window.collectionBehavior),
    @"background": window.backgroundColor, @"opaque": @(window.opaque), @"shadow": @(window.hasShadow),
    @"titleVisibility": @(window.titleVisibility), @"titlebarTransparent": @(window.titlebarAppearsTransparent),
    @"hidesOnDeactivate": @(window.hidesOnDeactivate),
  } forKey:window];
}
static bool ReadHandle(napi_env env, napi_value value, uintptr_t *address) {
  bool buffer = false; void *bytes = nullptr; size_t length = 0;
  if (napi_is_buffer(env, value, &buffer) != napi_ok || !buffer
      || napi_get_buffer_info(env, value, &bytes, &length) != napi_ok || length != sizeof(uintptr_t)) return false;
  std::memcpy(address, bytes, sizeof(*address)); return true;
}
static bool ReadNumber(napi_env env, napi_value object, const char *name, double *value) {
  napi_value field; napi_valuetype type;
  return napi_get_named_property(env, object, name, &field) == napi_ok
    && napi_typeof(env, field, &type) == napi_ok && type == napi_number
    && napi_get_value_double(env, field, value) == napi_ok && std::isfinite(*value);
}
static napi_value ApplyWindow(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t count = 2; napi_value args[2];
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2) return JSBoolean(env, false);
  uintptr_t address = 0;
  if (!ReadHandle(env, args[0], &address)) return JSBoolean(env, false);
  napi_valuetype type;
  if (napi_typeof(env, args[1], &type) != napi_ok || type != napi_object) return JSBoolean(env, false);
  double x, y, width, height;
  if (!ReadNumber(env, args[1], "x", &x) || !ReadNumber(env, args[1], "y", &y)
      || !ReadNumber(env, args[1], "width", &width) || !ReadNumber(env, args[1], "height", &height)
      || std::abs(x) > 10000000 || std::abs(y) > 10000000
      || width < 1 || height < 1 || width > 100000 || height > 100000) return JSBoolean(env, false);
  @autoreleasepool {
    @try {
      NSWindow *window = OwnedWindow(address);
      if (!window) return JSBoolean(env, false);
      CaptureWindow(window);
      // Keep a panel non-activating if Electron created it that way. No runtime
      // class changes, private selectors, key-window override, or focus calls.
      const NSWindowStyleMask style = NSWindowStyleMaskBorderless | (window.styleMask & NSWindowStyleMaskNonactivatingPanel);
      if (window.styleMask != style) window.styleMask = style;
      window.opaque = NO;
      window.backgroundColor = NSColor.clearColor;
      window.hasShadow = NO;
      window.hidesOnDeactivate = NO;
      window.level = NSStatusWindowLevel;
      NSWindowCollectionBehavior behavior = window.collectionBehavior;
      behavior &= ~(NSWindowCollectionBehaviorMoveToActiveSpace | NSWindowCollectionBehaviorFullScreenPrimary | NSWindowCollectionBehaviorFullScreenNone);
      behavior |= NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
      if (@available(macOS 13.0, *)) {
        behavior &= ~(NSWindowCollectionBehaviorPrimary | NSWindowCollectionBehaviorAuxiliary);
        behavior |= NSWindowCollectionBehaviorCanJoinAllApplications;
      }
      window.collectionBehavior = behavior;
      const NSRect target = NSMakeRect(x, PrimaryTop() - y - height, width, height);
      [window setFrame:target display:YES animate:NO];
      return JSBoolean(env, true);
    } @catch (NSException *exception) { return Failure(env, exception); }
  }
}

static napi_value RestoreWindow(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t count = 1; napi_value value;
  uintptr_t address = 0;
  if (napi_get_cb_info(env, info, &count, &value, nullptr, nullptr) != napi_ok || count != 1
      || !ReadHandle(env, value, &address)) return JSBoolean(env, false);
  @autoreleasepool {
    @try {
      NSWindow *window = OwnedWindow(address);
      if (!window) return JSBoolean(env, false);
      NSDictionary *state = [originalWindows objectForKey:window];
      if (!state) return JSBoolean(env, true);
      window.styleMask = static_cast<NSWindowStyleMask>([state[@"style"] unsignedIntegerValue]);
      window.level = [state[@"level"] integerValue];
      window.collectionBehavior = static_cast<NSWindowCollectionBehavior>([state[@"collection"] unsignedIntegerValue]);
      window.backgroundColor = state[@"background"];
      window.opaque = [state[@"opaque"] boolValue];
      window.hasShadow = [state[@"shadow"] boolValue];
      window.titleVisibility = static_cast<NSWindowTitleVisibility>([state[@"titleVisibility"] integerValue]);
      window.titlebarAppearsTransparent = [state[@"titlebarTransparent"] boolValue];
      window.hidesOnDeactivate = [state[@"hidesOnDeactivate"] boolValue];
      [originalWindows removeObjectForKey:window];
      return JSBoolean(env, true);
    } @catch (NSException *exception) { return Failure(env, exception); }
  }
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor functions[] = {
    {"getDisplays", nullptr, GetDisplays, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getMouseButtons", nullptr, GetMouseButtons, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"applyWindow", nullptr, ApplyWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"restoreWindow", nullptr, RestoreWindow, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]), functions);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
