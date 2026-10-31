/**
 * Frontmatter: copied parser behavior + serializer round-trip.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FrontmatterError,
  frontmatterBoolean,
  isKebabCase,
  parseFrontmatter,
  parseYamlSubset,
  quoteYamlString,
  serializeFrontmatter,
  serializeSkillFile,
} from '../src/frontmatter.js'

test('serializeSkillFile emits the CONTRACT write format', () => {
  const text = serializeSkillFile({
    name: 'my-skill',
    description: 'Does a thing.',
    whenToUse: 'When the thing needs doing.',
    modelInvocable: false,
    userInvocable: false,
    body: '# Body\n\nText.\n\n',
  })
  assert.equal(text, [
    '---',
    'name: my-skill',
    'description: "Does a thing."',
    'whenToUse: "When the thing needs doing."',
    'disable-model-invocation: true',
    'user-invocable: false',
    '---',
    '# Body',
    '',
    'Text.',
    '',
  ].join('\n'))
})

test('serializer omits empty whenToUse and bare-true booleans, and allows an empty body', () => {
  const text = serializeSkillFile({
    name: 'empty-body',
    description: 'No body here.',
    whenToUse: '   ',
    modelInvocable: true,
    userInvocable: true,
    body: '',
  })
  assert.equal(text, '---\nname: empty-body\ndescription: "No body here."\n---\n')
  const parsed = parseFrontmatter(text)
  assert.ok(parsed)
  assert.equal(parsed.data.name, 'empty-body')
  assert.equal(parsed.data.description, 'No body here.')
  assert.equal(Object.hasOwn(parsed.data, 'whenToUse'), false)
  assert.equal(Object.hasOwn(parsed.data, 'disable-model-invocation'), false)
  assert.equal(Object.hasOwn(parsed.data, 'user-invocable'), false)
  assert.equal(parsed.body.trim(), '')
})

test('quoted serializer round-trips quotes, backslashes, newlines, and tabs through the copied parser', () => {
  const description = 'He said "hello"\\ and\nleft a\ttab'
  const text = serializeSkillFile({ name: 'quoted', description, body: '' })
  const parsed = parseFrontmatter(text)
  assert.ok(parsed)
  assert.equal(parsed.data.description, description)
})

test('serialized booleans are read back by frontmatterBoolean', () => {
  const parsed = parseFrontmatter(serializeSkillFile({
    name: 'flags',
    description: 'Flags.',
    modelInvocable: false,
    userInvocable: false,
    body: 'x',
  }))
  assert.ok(parsed)
  assert.equal(frontmatterBoolean(parsed.data, 'disable-model-invocation'), true)
  assert.equal(frontmatterBoolean(parsed.data, 'user-invocable'), false)
  assert.equal(/^-?\d/.test(parsed.body.trim()), false)
})

test('quoteYamlString always double-quotes and escapes', () => {
  assert.equal(quoteYamlString('plain'), '"plain"')
  assert.equal(quoteYamlString('a "b"'), '"a \\"b\\""')
})

test('parseFrontmatter returns undefined for missing or unterminated frontmatter', () => {
  assert.equal(parseFrontmatter('# no frontmatter'), undefined)
  assert.equal(parseFrontmatter('---\nname: x\n'), undefined)
})

test('parseYamlSubset still throws FrontmatterError on unsupported YAML', () => {
  assert.throws(() => parseYamlSubset('  indented: nope'), FrontmatterError)
  assert.throws(() => parseYamlSubset('just a line'), FrontmatterError)
})

test('isKebabCase accepts the documented grammar and rejects others', () => {
  assert.equal(isKebabCase('my-skill-2'), true)
  assert.equal(isKebabCase('My-Skill'), false)
  assert.equal(isKebabCase('my_skill'), false)
  assert.equal(isKebabCase('-lead'), false)
  assert.equal(isKebabCase('trail-'), false)
})

test('serializeFrontmatter without body helpers writes only the block', () => {
  const block = serializeFrontmatter({ name: 'x', description: 'y' })
  assert.equal(block, '---\nname: x\ndescription: "y"\n---')
})
