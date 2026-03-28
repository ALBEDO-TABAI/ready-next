# 如何打开浏览器控制台并查看调试信息

## 步骤 1: 打开开发者工具

在 Ready 应用中，按以下快捷键：

- **macOS**: `Cmd + Option + I` 或 `Cmd + Shift + I`
- **Windows/Linux**: `Ctrl + Shift + I` 或 `F12`

这会打开开发者工具面板。

## 步骤 2: 切换到 Console 标签

在开发者工具中，点击顶部的 **Console** 标签。

## 步骤 3: 选中一个文本块

在 Ready 应用的画布中，点击选中一个文本块。

## 步骤 4: 在控制台运行以下命令

复制并粘贴以下代码到控制台，然后按回车：

```javascript
console.log('=== TextBlockShape 渲染数据 ===')
console.log(window.__lastTextBlockFontSize)

console.log('\n=== ComponentPanel 读取数据 ===')
console.log(window.__lastComponentPanelFontSize)

console.log('\n=== 对比结果 ===')
const tb = window.__lastTextBlockFontSize
const cp = window.__lastComponentPanelFontSize
if (tb && cp) {
  console.log('TextBlockShape 计算的字号:', tb.calculatedFontSize)
  console.log('ComponentPanel 读取的字号:', cp.calculatedFontSize)
  console.log('是否一致:', tb.calculatedFontSize === cp.calculatedFontSize ? '✅ 一致' : '❌ 不一致')

  console.log('\n详细数据:')
  console.log('meta.readyFontSize:', tb.metaReadyFontSize)
  console.log('props.fontSize:', tb.propsFontSize)
} else {
  console.log('❌ 数据未找到，请确保已选中文本块')
}
```

## 步骤 5: 截图并发送

将控制台的输出截图发给我，或者直接复制输出的文字。

## 如果看不到数据

如果运行后显示 `undefined`，说明代码还没有被执行。请：

1. **完全重启应用**（关闭后重新运行 `npm run dev`）
2. **等待应用完全加载**
3. **选中一个文本块**
4. **再次运行上面的命令**

## 预期输出示例

```
=== TextBlockShape 渲染数据 ===
{
  shapeId: "shape:abc123",
  metaReadyFontSize: 16,
  propsFontSize: 16,
  calculatedFontSize: 16,
  timestamp: 1710144000000
}

=== ComponentPanel 读取数据 ===
{
  shapeId: "shape:abc123",
  metaFontSize: 16,
  propsFontSize: 16,
  calculatedFontSize: 16,
  timestamp: 1710144000000
}

=== 对比结果 ===
TextBlockShape 计算的字号: 16
ComponentPanel 读取的字号: 16
是否一致: ✅ 一致
```

如果看到 `❌ 不一致`，请把完整的输出发给我！
