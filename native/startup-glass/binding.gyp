{
  "targets": [{
    "target_name": "ready_glass",
    "sources": ["glass.mm"],
    "xcode_settings": { "CLANG_ENABLE_OBJC_ARC": "YES", "MACOSX_DEPLOYMENT_TARGET": "12.0", "OTHER_CFLAGS": ["-fobjc-arc"], "CLANG_CXX_LANGUAGE_STANDARD": "c++17" },
    "link_settings": { "libraries": ["-framework AppKit", "-framework QuartzCore"] }
  }]
}
