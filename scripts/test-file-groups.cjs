'use strict'

function isTopLevelTestFile(name) {
  return name.endsWith('.test.ts') || name.endsWith('.test.tsx')
}

function isSkillChildTestFile(name) {
  return name.startsWith('skill-child-') && isTopLevelTestFile(name)
}

function isSerialPerformanceTestFile(name) {
  return name.endsWith('.serial.test.ts') || name.endsWith('.serial.test.tsx')
}

function classifyTestFile(name) {
  if (!isTopLevelTestFile(name)) return null
  if (isSkillChildTestFile(name)) return 'skill_child'
  if (isSerialPerformanceTestFile(name)) return 'serial_performance'
  return 'parallel'
}

module.exports = {
  classifyTestFile,
  isSerialPerformanceTestFile,
  isSkillChildTestFile,
  isTopLevelTestFile,
}
