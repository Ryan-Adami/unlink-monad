import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

import {
	decodeBase64Json,
	DEMO_ADMIN_AUTH_HEADER,
	fetchWithPusdPayment,
} from '@repo/pusd-domain'

import '../../pusd-demo-worker.app'

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T
}

const demoAdminToken = 'vitest-demo-admin-token'

function authHeaders(
	headers: Record<string, string> = {}
): Record<string, string> {
	return {
		[DEMO_ADMIN_AUTH_HEADER]: demoAdminToken,
		...headers,
	}
}

describe('pusd demo worker', () => {
	beforeEach(async () => {
		const reset = await SELF.fetch('https://example.com/admin/reset', {
			method: 'POST',
			headers: authHeaders(),
		})
		expect(reset.status).toBe(200)
	})

	it('mints private PUSD and burns back to fiat', async () => {
		const mintResponse = await SELF.fetch('https://example.com/mint-intents', {
			method: 'POST',
			headers: authHeaders({
				'content-type': 'application/json',
			}),
			body: JSON.stringify({
				userId: 'alice',
				amountCents: 1_000,
			}),
		})

		expect(mintResponse.status).toBe(200)
		const mintBody = await json<{
			user: { fiatCents: number; privatePusdCents: number }
			system: { reserveCents: number; totalSupplyCents: number }
		}>(mintResponse)

		expect(mintBody.user.fiatCents).toBe(499_000)
		expect(mintBody.user.privatePusdCents).toBe(1_000)
		expect(mintBody.system.reserveCents).toBe(1_000)
		expect(mintBody.system.totalSupplyCents).toBe(1_000)

		const burnResponse = await SELF.fetch('https://example.com/burn-intents', {
			method: 'POST',
			headers: authHeaders({
				'content-type': 'application/json',
			}),
			body: JSON.stringify({
				userId: 'alice',
				amountCents: 400,
			}),
		})

		expect(burnResponse.status).toBe(200)
		const balancesResponse = await SELF.fetch('https://example.com/balances?userId=alice', {
			headers: authHeaders(),
		})
		expect(balancesResponse.status).toBe(200)
		const balances = await json<{
			user: { fiatCents: number; privatePusdCents: number }
			system: { reserveCents: number; totalSupplyCents: number }
		}>(balancesResponse)

		expect(balances.user.fiatCents).toBe(499_400)
		expect(balances.user.privatePusdCents).toBe(600)
		expect(balances.system.reserveCents).toBe(600)
		expect(balances.system.totalSupplyCents).toBe(600)
	})

	it('supports a local x402 payment retry flow', async () => {
		const paidResponse = await fetchWithPusdPayment({
			resourceUrl: 'https://example.com/demo/paid',
			userId: 'bob',
			adminToken: demoAdminToken,
			fetchFn: (input, init) => SELF.fetch(input, init),
		})

		expect(paidResponse.status).toBe(200)
		expect(paidResponse.headers.get('PAYMENT-RESPONSE')).toBeTruthy()
		expect(paidResponse.headers.get('x-pusd-settlement-mode')).toBe('demo-ledger')
		const paymentResponse = decodeBase64Json<{
			challengeId: string
			receiptId: string
			transaction: string | null
			settlementMode: string
		}>(paidResponse.headers.get('PAYMENT-RESPONSE')!)
		expect(paymentResponse.transaction).toBeNull()
		expect(paymentResponse.settlementMode).toBe('demo-ledger')
		const paidBody = await json<{ ok: boolean }>(paidResponse)
		expect(paidBody.ok).toBe(true)
	})

	it('exposes a live-capable Unlink smoke route', async () => {
		const response = await SELF.fetch('https://example.com/admin/unlink-smoke', {
			method: 'POST',
			headers: authHeaders({
				'content-type': 'application/json',
			}),
			body: JSON.stringify({
				userId: 'smoke-check',
			}),
		})

		expect(response.status).toBe(200)
		const body = await json<{
			result: {
				mode: string
				userId: string
				walletId: string
				address: string
				fallbackUsed: boolean
			}
		}>(response)

		expect(body.result.userId).toBe('smoke-check')
		expect(body.result.walletId).toContain('smoke-check')
		expect(body.result.address.startsWith('0x')).toBe(true)
		expect(body.result.fallbackUsed).toBe(false)
	})

	it('reports a healthy reserve invariant after minting', async () => {
		await SELF.fetch('https://example.com/mint-intents', {
			method: 'POST',
			headers: authHeaders({
				'content-type': 'application/json',
			}),
			body: JSON.stringify({
				userId: 'carol',
				amountCents: 250,
			}),
		})

		const reconcile = await SELF.fetch('https://example.com/admin/reconcile', {
			method: 'POST',
			headers: authHeaders(),
		})

		expect(reconcile.status).toBe(200)
		const reconcileBody = await json<{ healthy: boolean }>(reconcile)
		expect(reconcileBody.healthy).toBe(true)
	})
})
