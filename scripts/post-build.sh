#!/bin/bash

# 构建后处理脚本：对应用进行 ad-hoc 签名并清除隔离属性

APP_PATH="exports/mac-arm64/Ready.app"
DMG_PATH="exports/Ready-0.1.0-arm64.dmg"

echo "🔐 开始 ad-hoc 签名..."

# 对应用进行 ad-hoc 签名（使用 - 作为身份标识）
if [ -d "$APP_PATH" ]; then
  codesign --force --deep --sign - "$APP_PATH"
  echo "✅ 应用签名完成"
else
  echo "⚠️  应用目录不存在: $APP_PATH"
fi

# 清除 DMG 的隔离属性
if [ -f "$DMG_PATH" ]; then
  xattr -cr "$DMG_PATH"
  echo "✅ 已清除 DMG 隔离属性"

  # 显示 DMG 信息
  echo ""
  echo "📦 DMG 信息:"
  ls -lh "$DMG_PATH"
  echo ""
  echo "🔍 扩展属性:"
  xattr "$DMG_PATH" || echo "无扩展属性"
else
  echo "⚠️  DMG 文件不存在: $DMG_PATH"
fi

echo ""
echo "✨ 构建后处理完成！"
