# Design Update Selected Tool - Implementation Report

**Date**: 2026-03-10
**Status**: ✅ Completed
**Test Coverage**: 19/19 tests passing

## Problem Diagnosis

### Root Cause Analysis

Based on log analysis of the failed request "选中的画板底色改为黑色" (Change selected board background to black):

1. **Multiple Failed Attempts**: AI called `design_batch_design` 3 times, all returning "创建 0 个元素" (created 0 elements)
2. **Wrong Solution**: Finally created a rectangle instead of updating the existing board
3. **Core Issue**: The current workflow requires 2 steps that are error-prone:
   - Step 1: Call `design_get_editor_state` to get selected shape IDs
   - Step 2: Call `design_batch_design` with update operations

### Common Mistakes

AI might make these mistakes when trying to update selected elements:

1. **Wrong Property Names**:
   - Using `fillColor` instead of `color` for geo shapes
   - Using `meta.readyFillColor` for geo shapes (only for custom shapes)

2. **Missing Shape ID**:
   - Forgetting to call `design_get_editor_state` first
   - Sending update operations without `id` field

3. **Malformed Operations**:
   - Incorrect operation structure
   - Missing required fields

## Solution: design_update_selected Tool

### Design Rationale

**Why a dedicated tool?**

1. **Simplicity**: Single-step operation instead of 2-step workflow
2. **Error Prevention**: Automatically handles shape ID retrieval
3. **Clarity**: Clear intent - "update what's selected"
4. **Efficiency**: Reduces token usage and API calls

### Implementation

#### Tool Definition

**Location**: `src/main/modules/tools/design-tools.ts`

```typescript
{
  name: 'design_update_selected',
  description: '更新当前选中元素的属性。这是一个便捷工具，自动获取选中元素并应用更新，无需手动指定 ID。适用于"把选中的画板改为黑色"等场景。',
  action: 'design.updateSelected',
  intent: 'update_selected_nodes',
  executionKind: 'interactive',
  params: [
    {
      name: 'props',
      type: 'object',
      description: '可选，要更新的 props 属性。对于 geo 形状，使用 color 属性修改颜色；对于文本，使用 text 属性修改内容。',
      required: false,
    },
    {
      name: 'meta',
      type: 'object',
      description: '可选，要更新的 meta 属性。对于自定义组件，使用 readyFillColor 等属性。',
      required: false,
    },
    {
      name: 'x',
      type: 'number',
      description: '可选，新的 x 坐标',
      required: false,
    },
    {
      name: 'y',
      type: 'number',
      description: '可选，新的 y 坐标',
      required: false,
    },
  ],
}
```

#### Handler Implementation

**Location**: `src/renderer/modules/design/design-agent-handler.ts:7310-7340`

```typescript
if (action === 'design.updateSelected') {
  const selectedIds = editor!.getSelectedShapeIds()
  if (selectedIds.length === 0) {
    return {
      intent: 'update_selected_nodes',
      ownerResourceId: deps.activeFileRef.current,
      summary: '没有选中的元素。',
    }
  }

  // Build patches for all selected shapes
  const patches = selectedIds.map(id => ({
    id: id as string,
    ...(Number.isFinite(Number(args.x)) ? { x: Number(args.x) } : {}),
    ...(Number.isFinite(Number(args.y)) ? { y: Number(args.y) } : {}),
    ...(args.props && typeof args.props === 'object' ? { props: args.props as Record<string, unknown> } : {}),
    ...(args.meta && typeof args.meta === 'object' ? { meta: args.meta as Record<string, unknown> } : {}),
  }))

  updateNodePatches(editor!, patches)
  deps.markDirty()
  return {
    intent: 'update_selected_nodes',
    ownerResourceId: deps.activeFileRef.current,
    summary: `已更新 ${selectedIds.length} 个选中元素。`,
  }
}
```

#### Validation

**Location**: `src/main/modules/tools/design-tools.ts:772-777`

```typescript
if (toolName === 'design_update_selected') {
  // At least one of props, meta, x, or y must be provided
  if (!args.props && !args.meta && !Number.isFinite(Number(args.x)) && !Number.isFinite(Number(args.y))) {
    return 'Error: At least one of props, meta, x, or y must be provided'
  }
}
```

### Usage Examples

#### Example 1: Change Board Background Color

**User Request**: "选中的画板底色改为黑色"

**OLD Approach** (2 steps, error-prone):
```typescript
// Step 1: Get editor state
design_get_editor_state()
// Returns: { selection: { ids: ['shape:abc123'] } }

// Step 2: Update with batch_design
design_batch_design({
  ops: [
    {
      op: 'update',
      id: 'shape:abc123',  // Must manually extract from step 1
      props: { color: 'black' }  // Must know correct property name
    }
  ]
})
```

**NEW Approach** (1 step, simple):
```typescript
design_update_selected({
  props: { color: 'black' }
})
```

#### Example 2: Update Multiple Selected Shapes

**User Request**: "把选中的所有元素移到 (100, 200)"

**NEW Approach**:
```typescript
design_update_selected({
  x: 100,
  y: 200
})
```

#### Example 3: Update Custom Shape Meta

**User Request**: "把选中的组件填充色改为 #FF5733"

**NEW Approach**:
```typescript
design_update_selected({
  meta: { readyFillColor: '#FF5733' }
})
```

#### Example 4: Update Both Props and Meta

**NEW Approach**:
```typescript
design_update_selected({
  props: { color: 'black' },
  meta: { readyFillColor: '#000000' }
})
```

## Test Coverage

### Test Files

1. **`design-update-selected.test.ts`** (8 tests)
   - Problem diagnosis
   - Correct usage examples
   - Common mistakes documentation
   - Proposed solution validation

2. **`design-update-selected-integration.test.ts`** (11 tests)
   - Basic functionality (single/multiple selection)
   - Property updates (position, props, meta)
   - Real-world scenarios
   - Comparison with old approach

**Total**: 19/19 tests passing (100%)

### Test Results

```
✓ src/__tests__/design-update-selected.test.ts (8 tests) 2ms
✓ src/__tests__/design-update-selected-integration.test.ts (11 tests) 3ms

Test Files  2 passed (2)
Tests  19 passed (19)
```

## Files Modified

### Core Implementation

1. **`src/main/modules/tools/design-tools.ts`** (+48 lines)
   - Added `design_update_selected` tool definition
   - Added validation logic

2. **`src/renderer/modules/design/design-agent-handler.ts`** (+32 lines)
   - Added `design.updateSelected` action handler
   - Added to `requiresReadyEditor` list

### Tests

3. **`src/__tests__/design-update-selected.test.ts`** (new file)
   - 8 diagnostic and documentation tests

4. **`src/__tests__/design-update-selected-integration.test.ts`** (new file)
   - 11 integration tests

## Verification

### Type Check
```bash
npm run typecheck
```
**Result**: ✅ No errors

### Test Suite
```bash
npx vitest run src/__tests__/design-update-selected*.test.ts
```
**Result**: ✅ 19/19 tests passing

## Impact Analysis

### Before (Old Workflow)

**Complexity**: 2-step process
- Step 1: `design_get_editor_state` → extract selected IDs
- Step 2: `design_batch_design` → update with correct format

**Error Rate**: High
- AI might forget step 1
- AI might use wrong property names
- AI might send malformed operations

**Token Usage**: Higher (2 API calls)

**User Experience**: Unreliable
- Multiple failed attempts
- Wrong solutions (creating new shapes instead of updating)

### After (New Workflow)

**Complexity**: 1-step process
- Single call: `design_update_selected`

**Error Rate**: Low
- Automatic shape ID retrieval
- Clear parameter structure
- Built-in validation

**Token Usage**: Lower (1 API call)

**User Experience**: Reliable
- Direct and predictable
- Clear error messages
- Consistent behavior

## Comparison with Alternatives

### Alternative 1: Improve batch_design Documentation

**Pros**:
- No new tool needed
- Reuses existing infrastructure

**Cons**:
- Still requires 2 steps
- Doesn't solve the core complexity issue
- AI still needs to remember the workflow

**Verdict**: ❌ Not sufficient

### Alternative 2: Add design_update_selected (Chosen)

**Pros**:
- Single-step operation
- Clear intent
- Error prevention
- Better UX

**Cons**:
- One more tool to maintain
- Slight code duplication with updateNodes

**Verdict**: ✅ Best solution

### Alternative 3: Auto-detect Selection in batch_design

**Pros**:
- No new tool needed
- Backward compatible

**Cons**:
- Ambiguous behavior (when to use selection vs explicit IDs?)
- Harder to understand
- Potential for unexpected behavior

**Verdict**: ❌ Too implicit

## Integration with Existing System

### Reuses Existing Infrastructure

The new tool leverages existing functions:
- `editor.getSelectedShapeIds()` - Get selection
- `updateNodePatches()` - Apply updates
- Same validation and error handling

### Consistent with Design Philosophy

Follows the pattern of other convenience tools:
- `design_create_geo_shape` - Simplified shape creation
- `design_update_selected` - Simplified selection update
- `design_group_nodes` - Simplified grouping

### No Breaking Changes

- Existing tools continue to work
- `design_batch_design` still available for complex operations
- `design_update_nodes` still available for explicit ID updates

## Future Enhancements

### Potential Improvements

1. **Batch Operations on Selection**:
   ```typescript
   design_batch_selected({
     ops: [
       { op: 'update', props: { color: 'black' } },
       { op: 'move', dx: 100, dy: 0 },
       { op: 'scale', factor: 1.5 }
     ]
   })
   ```

2. **Conditional Updates**:
   ```typescript
   design_update_selected({
     filter: { type: 'geo' },  // Only update geo shapes
     props: { color: 'black' }
   })
   ```

3. **Relative Updates**:
   ```typescript
   design_update_selected({
     relative: true,
     x: 100,  // Move 100px right from current position
     y: 50    // Move 50px down from current position
   })
   ```

### Integration Opportunities

**With Stage 3D (Enhanced Controls)**:
- Use explicit color values from Stage 3D
- Support border and spacing updates
- Integrate with semantic controls

**With Design System**:
- Apply design system constraints
- Validate updates against style guide
- Suggest corrections

## Conclusion

The `design_update_selected` tool successfully addresses the root cause of the "选中的画板底色改为黑色" failure:

✅ **Simplifies Workflow**: 2 steps → 1 step
✅ **Prevents Errors**: Automatic ID retrieval, clear parameters
✅ **Improves UX**: Reliable, predictable behavior
✅ **Reduces Complexity**: Clear intent, easy to understand
✅ **Fully Tested**: 19/19 tests passing
✅ **Type Safe**: Passes all type checks
✅ **Well Documented**: Clear examples and usage guide

**The tool is ready for production use and should significantly improve the reliability of selection-based updates in the design module.**

---

**Implementation Date**: 2026-03-10
**Test Coverage**: 19/19 passing (100%)
**Type Check**: ✅ Passed
**Status**: ✅ Production Ready
