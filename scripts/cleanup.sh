#!/bin/bash

# Ready 项目清理脚本
# 用于删除不必要的文件，减少项目体积

echo "🧹 开始清理 Ready 项目..."
echo ""

# 统计清理前的大小
BEFORE_SIZE=$(du -sh . | cut -f1)
echo "清理前项目大小: $BEFORE_SIZE"
echo ""

# 1. 删除旧的 dist 文件夹 (1.1GB)
if [ -d "dist" ]; then
  echo "🗑️  删除旧的 dist 文件夹..."
  rm -rf dist
  echo "✅ 已删除 dist/"
fi

# 2. 删除 out 文件夹 (20MB - 构建产物)
if [ -d "out" ]; then
  echo "🗑️  删除 out 文件夹..."
  rm -rf out
  echo "✅ 已删除 out/"
fi

# 3. 删除根目录下的临时图片文件
echo "🗑️  删除根目录下的临时图片..."
rm -f *.png *.jpg *.jpeg 2>/dev/null
echo "✅ 已删除临时图片文件"

# 4. 删除 TypeScript 构建缓存
echo "🗑️  删除 TypeScript 构建缓存..."
rm -f tsconfig.*.tsbuildinfo 2>/dev/null
echo "✅ 已删除 .tsbuildinfo 文件"

# 5. 删除日志文件夹（如果不需要）
if [ -d "logs" ]; then
  echo "🗑️  删除 logs 文件夹..."
  rm -rf logs
  echo "✅ 已删除 logs/"
fi

# 6. 清理 exports 文件夹中的旧文件（保留最新的 DMG）
if [ -d "exports" ]; then
  echo "🗑️  清理 exports 文件夹..."
  # 删除 mac-arm64 未打包目录
  rm -rf exports/mac-arm64
  # 删除 kimi 文件夹
  rm -rf exports/kimi
  # 删除调试文件
  rm -f exports/builder-debug.yml
  rm -f exports/builder-effective-config.yaml
  echo "✅ 已清理 exports/"
fi

# 7. 删除不需要的文档文件（可选）
echo "🗑️  删除临时文档文件..."
rm -f DESIGN_*.md 2>/dev/null
rm -f TEXT_LAYOUT_*.md 2>/dev/null
rm -f FONT_SIZE_*.md 2>/dev/null
rm -f TLDRAW_*.md 2>/dev/null
rm -f SPACER_*.md 2>/dev/null
rm -f RHYTHM_*.md 2>/dev/null
rm -f AGENT_DECISION_*.md 2>/dev/null
rm -f BROWSER_DECISION_*.md 2>/dev/null
rm -f TOOL_FORCING_*.md 2>/dev/null
rm -f ARCHITECTURE_ISSUE_*.md 2>/dev/null
rm -f OPENCLAW_*.md 2>/dev/null
rm -f PRIORITY_*.md 2>/dev/null
rm -f TESTING_GUIDE_*.md 2>/dev/null
rm -f MEMORY_*.md 2>/dev/null
rm -f FEISHU_*.md 2>/dev/null
echo "✅ 已删除临时文档文件"

# 8. 清理 node_modules 中未使用的包（可选，需要重新安装）
# echo "🗑️  清理 node_modules..."
# npm prune --production
# echo "✅ 已清理未使用的依赖"

echo ""
echo "🎉 清理完成！"
echo ""

# 统计清理后的大小
AFTER_SIZE=$(du -sh . | cut -f1)
echo "清理后项目大小: $AFTER_SIZE"
echo ""

echo "📊 建议："
echo "  - 如果不需要开发，可以删除 node_modules 并只保留 exports/Ready-*.dmg"
echo "  - 可以将 DMG 文件移到其他位置，然后删除整个项目文件夹"
echo "  - 如果需要继续开发，运行 'npm install' 重新安装依赖"
