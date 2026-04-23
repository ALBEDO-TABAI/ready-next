# Template Engine Audit Fixes Design

## Goal

修复本轮审计确认的模板引擎缺口，让模板加载、报告组装和文档说明三部分重新一致，并把关键回归用测试锁住。

## Scope

- 为 `include` 增加缺文件报错、循环引用检测和 family fallback。
- 为最终报告增加节名完整性校验，缺节时直接报清晰错误。
- 修正重复图块标记的回退替换逻辑。
- 清理重复定义的未解析占位符规则。
- 更新设计文档，移除已经过时的命名和行为描述。

## Non-Goals

- 不重做整套 family 模板体系。
- 不改动现有路由判断或大段模板文案。
- 不引入新的二次补调流程，只先把缺节拦住。

## Success Criteria

- 相关问题都有自动化测试覆盖，并且先失败后通过。
- `tests/test_audiovisual_template_engine.py` 全量通过。
- 文档中关于模板回退和 family 复用的描述与当前实现一致。
