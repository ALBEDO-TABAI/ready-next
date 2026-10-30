// The renderer's Node module resolution does not follow package export maps.
// Keep the public runtime import and use Lucide's exact shipped declarations.
declare module 'lucide-react/dynamic' {
  export { DynamicIcon, iconNames, type IconName } from 'lucide-react/dist/dynamic'
}
