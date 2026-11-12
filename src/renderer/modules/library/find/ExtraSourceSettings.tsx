import type { SourceSettings } from '../../../../shared/library-sources'
import { Checkbox } from '../../../components/ui'
export default function ExtraSourceSettings({ value, onChange }: { value: SourceSettings; onChange(value: SourceSettings): void }) {
  return <details><summary>更多书源…</summary>
    <Checkbox checked={value.treasure} onChange={treasure => onChange({ ...value, treasure })} label="电子书宝库" />
    <Checkbox checked={value.ctfile} onChange={ctfile => onChange({ ...value, ctfile })} label="城通网盘链接取回" />
    <p>验证码需要你手动填写，多卷压缩包请到网盘选择后导入。</p>
  </details>
}
