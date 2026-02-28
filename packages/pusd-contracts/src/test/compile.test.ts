import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { compilePusdContract } from '../index'

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'PUSD.sol')

describe('PUSD contract', () => {
	it('compiles and exposes EIP-3009 methods', () => {
		const source = readFileSync(sourcePath, 'utf8')
		const compiled = compilePusdContract(source)
		const abiEntries = compiled.abi as Array<{ name?: string; type?: string }>

		expect(compiled.bytecode.length).toBeGreaterThan(0)
		expect(
			abiEntries.some((entry) => entry.type === 'function' && entry.name === 'transferWithAuthorization')
		).toBe(true)
		expect(
			abiEntries.some((entry) => entry.type === 'function' && entry.name === 'receiveWithAuthorization')
		).toBe(true)
		expect(
			abiEntries.some((entry) => entry.type === 'function' && entry.name === 'authorizationState')
		).toBe(true)
	})
})
