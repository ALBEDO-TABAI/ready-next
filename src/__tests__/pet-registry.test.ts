import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_PET_SETTINGS,
  normalizePetSettings,
  resolvePetDefinitions,
} from '../main/modules/pet/pet-registry'

function makePet(root: string, id: string, displayName: string): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pet.json'), JSON.stringify({
    id,
    displayName,
    description: `${displayName} description`,
    spritesheetPath: 'spritesheet.webp',
  }))
  writeFileSync(join(dir, 'spritesheet.webp'), 'fake-webp')
}

test('normalizePetSettings defaults to disabled desktop pet with balanced bubble behavior', () => {
  const settings = normalizePetSettings(null)

  assert.deepEqual(settings, DEFAULT_PET_SETTINGS)
  assert.equal(settings.enabled, false)
  assert.equal(settings.bubbleEnabled, true)
  assert.equal(settings.alwaysOnTop, true)
  assert.equal(settings.size, 'medium')
})

test('resolvePetDefinitions maps known Codex pet ids to Ready default names and applies custom metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-pets-'))
  makePet(root, 'white-chinchilla-cat', '白色金吉拉猫')
  makePet(root, 'cream-gold-cat', '奶油白脸金眼猫')

  const pets = resolvePetDefinitions({
    petsRoot: root,
    customPetMeta: {
      'cream-gold-cat': {
        displayName: '我的奶茶',
        description: '会陪我工作的猫',
      },
    },
  })

  assert.equal(pets.length, 2)
  assert.equal(pets.find((pet) => pet.id === 'white-chinchilla-cat')?.displayName, '奶油')
  assert.equal(pets.find((pet) => pet.id === 'cream-gold-cat')?.displayName, '我的奶茶')
  assert.equal(pets.find((pet) => pet.id === 'cream-gold-cat')?.description, '会陪我工作的猫')
})

test('resolvePetDefinitions marks broken pet resources unavailable without hiding valid pets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-pets-'))
  makePet(root, 'orange-close-cat', '橘色近脸猫')
  mkdirSync(join(root, 'broken-cat'), { recursive: true })
  writeFileSync(join(root, 'broken-cat', 'pet.json'), JSON.stringify({
    id: 'broken-cat',
    displayName: 'Broken',
    description: 'missing spritesheet',
    spritesheetPath: 'missing.webp',
  }))

  const pets = resolvePetDefinitions({ petsRoot: root, customPetMeta: {} })

  assert.equal(pets.find((pet) => pet.id === 'orange-close-cat')?.displayName, '弟弟')
  assert.equal(pets.find((pet) => pet.id === 'orange-close-cat')?.available, true)
  assert.equal(pets.find((pet) => pet.id === 'broken-cat')?.available, false)
})
