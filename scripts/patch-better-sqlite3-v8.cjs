#!/usr/bin/env node

// better-sqlite3 12.10.0 calls V8 directly. Each substitution below is guarded by the
// V8 version the native rebuild compiles against, so the same patched source builds for
// the pinned Electron whatever its V8: V8 14 needs tagged v8::External values, and V8 15
// removed HolderV2()/GetPrototypeV2() again in favour of Holder()/GetPrototype().

const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = process.cwd()
const PACKAGE_PATH = join(ROOT, 'node_modules', 'better-sqlite3', 'package.json')
const SOURCE_ROOT = join(ROOT, 'node_modules', 'better-sqlite3', 'src')

function info(message) {
  console.log(`[patch-better-sqlite3-v8] ${message}`)
}

function fail(message) {
  console.error(`[patch-better-sqlite3-v8] ${message}`)
  process.exit(1)
}

function replaceOnce(file, before, after) {
  const path = join(SOURCE_ROOT, file)
  if (!existsSync(path)) fail(`missing source file ${path}`)
  const source = readFileSync(path, 'utf8')
  if (source.includes(after)) return false
  if (!source.includes(before)) fail(`expected patch anchor not found in ${file}`)
  writeFileSync(path, source.replace(before, after))
  return true
}

function replaceAny(file, replacements) {
  const path = join(SOURCE_ROOT, file)
  if (!existsSync(path)) fail(`missing source file ${path}`)
  let source = readFileSync(path, 'utf8')
  for (const { before, after } of replacements) {
    if (source.includes(after)) return false
    if (source.includes(before)) {
      writeFileSync(path, source.replace(before, after))
      return true
    }
  }
  fail(`expected patch anchor not found in ${file}`)
}

if (!existsSync(PACKAGE_PATH)) {
  info('better-sqlite3 is not installed; skipping')
  process.exit(0)
}

const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
if (pkg.version !== '12.10.0') {
  info(`better-sqlite3 ${pkg.version} is not the patch target (12.10.0); skipping`)
  process.exit(0)
}

let changed = 0

changed += replaceOnce(
  'util/macros.cpp',
  '#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())',
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 14
#define BETTER_SQLITE3_EXTERNAL_POINTER_TAG v8::kExternalPointerTypeTagDefault
#define BETTER_SQLITE3_EXTERNAL_VALUE(external) (external)->Value(BETTER_SQLITE3_EXTERNAL_POINTER_TAG)
#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value), BETTER_SQLITE3_EXTERNAL_POINTER_TAG)
#else
#define BETTER_SQLITE3_EXTERNAL_VALUE(external) (external)->Value()
#define BETTER_SQLITE3_EXTERNAL_NEW(isolate, value) v8::External::New((isolate), (value))
#endif
#define OnlyAddon static_cast<Addon*>(BETTER_SQLITE3_EXTERNAL_VALUE(info.Data().As<v8::External>()))`,
)

changed += replaceOnce(
  'better_sqlite3.cpp',
  'v8::Local<v8::External> data = v8::External::New(isolate, addon);',
  'v8::Local<v8::External> data = BETTER_SQLITE3_EXTERNAL_NEW(isolate, addon);',
)

changed += replaceOnce(
  'util/macros.cpp',
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 13
// v8::Object::GetPrototype has been deprecated. See http://crbug.com/333672197
#define GET_PROTOTYPE(obj) ((obj)->GetPrototypeV2())`,
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 15
// V8 15 removed GetPrototypeV2() and restored GetPrototype().
#define GET_PROTOTYPE(obj) ((obj)->GetPrototype())
#elif defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 13
// v8::Object::GetPrototype has been deprecated. See http://crbug.com/333672197
#define GET_PROTOTYPE(obj) ((obj)->GetPrototypeV2())`,
)

changed += replaceOnce(
  'util/macros.cpp',
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 13
#define PROPERTY_HOLDER(info) (info).HolderV2()`,
  `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 15
// V8 15 removed HolderV2() and restored Holder().
#define PROPERTY_HOLDER(info) (info).Holder()
#elif defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 13
#define PROPERTY_HOLDER(info) (info).HolderV2()`,
)

changed += replaceAny(
  'util/helpers.cpp',
  [
    {
      before: `\t\tfunc,
\t\t0,
\t\tdata`,
      after: `\t\tfunc,
\t\tstatic_cast<v8::AccessorNameSetterCallbackV2>(nullptr),
\t\tdata`,
    },
    {
      before: `\t\tfunc,
\t\tnullptr,
\t\tdata`,
      after: `\t\tfunc,
\t\tstatic_cast<v8::AccessorNameSetterCallbackV2>(nullptr),
\t\tdata`,
    },
  ],
)

info(changed === 0 ? 'already patched' : `applied ${changed} substitution(s)`)
