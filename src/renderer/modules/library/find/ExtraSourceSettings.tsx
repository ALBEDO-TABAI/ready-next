import type { SourceSettings } from '../../../../shared/library-sources'
export default function ExtraSourceSettings({ value, onChange }: { value: SourceSettings; onChange(value: SourceSettings): void }) {
  return <details><summary>更多书源…</summary>
    <label><input type="checkbox" checked={value.treasure} onChange={e => onChange({ ...value, treasure: e.target.checked })} />电子书宝库</label>
    <label><input type="checkbox" checked={value.ctfile} onChange={e => onChange({ ...value, ctfile: e.target.checked })} />城通网盘链接取回</label>
    <p>验证码需要你手动填写，多卷压缩包请到网盘选择后导入。</p>
  </details>
}
