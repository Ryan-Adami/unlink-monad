import { z } from 'zod'

export const TOKEN_NAME = 'Private USD'
export const TOKEN_SYMBOL = 'PUSD'
export const TOKEN_VERSION = '1'
export const TOKEN_STANDARD = 'EIP-3009'
export const MONAD_TESTNET_CHAIN_ID = 10143
export const MONAD_CAIP2 = `eip155:${MONAD_TESTNET_CHAIN_ID}`
export const DEFAULT_DEMO_USER_ID = 'demo-user'
export const DEFAULT_DEMO_PRICE_CENTS = 125
export const DEMO_ADMIN_AUTH_HEADER = 'x-demo-admin-auth'

export const MintIntentStatuses = [
	'initiated',
	'book_transfer_pending',
	'funds_received',
	'minting',
	'private_deposit_pending',
	'completed',
	'failed',
	'manual_review',
] as const

export const BurnIntentStatuses = [
	'initiated',
	'private_exit_pending',
	'burning',
	'payout_pending',
	'completed',
	'failed',
	'manual_review',
] as const

export const FundingIntentStatuses = [
	'initiated',
	'checking_payer_balance',
	'minting_liquidity',
	'exiting_private_balance',
	'payer_funded',
	'completed',
	'failed',
	'manual_review',
] as const

export type MintIntentStatus = (typeof MintIntentStatuses)[number]
export type BurnIntentStatus = (typeof BurnIntentStatuses)[number]
export type FundingIntentStatus = (typeof FundingIntentStatuses)[number]

export const PositiveAmountSchema = z
	.number()
	.int()
	.positive()
	.describe('Whole-number amount in USD cents')

export const UserIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[a-zA-Z0-9_-]+$/)

export const MintRequestSchema = z.object({
	userId: UserIdSchema.default(DEFAULT_DEMO_USER_ID),
	amountCents: PositiveAmountSchema,
})

export const BurnRequestSchema = z.object({
	userId: UserIdSchema.default(DEFAULT_DEMO_USER_ID),
	amountCents: PositiveAmountSchema,
})

export const EnsureFundsRequestSchema = z.object({
	userId: UserIdSchema.default(DEFAULT_DEMO_USER_ID),
	amountCents: PositiveAmountSchema.default(DEFAULT_DEMO_PRICE_CENTS),
})

export const FacilitatorSettlementSchema = z.object({
	challengeId: z.string().trim().min(1),
})

export interface ChallengePayload {
	challengeId: string
	amountCents: number
	token: {
		name: string
		symbol: string
		standard: string
		chainId: number
		caip2: string
	}
	facilitatorPath: string
	payerWallet: string
	settlementMode: 'demo-ledger'
}

export interface PaymentSignaturePayload {
	challengeId: string
	receiptId: string
}

export interface PaymentResponsePayload {
	challengeId: string
	receiptId: string
	transaction: string | null
	settlementMode: 'demo-ledger'
}

export interface PusdPaymentFetchOptions {
	resourceUrl: string
	userId: string
	adminToken?: string
	workerOrigin?: string
	ensureFundsPath?: string
	requestInit?: RequestInit
	fetchFn?: typeof fetch
}

export async function fetchWithPusdPayment(
	options: PusdPaymentFetchOptions
): Promise<Response> {
	const fetchFn = options.fetchFn ?? fetch
	const initialResponse = await fetchFn(options.resourceUrl, options.requestInit)

	if (initialResponse.status !== 402) {
		return initialResponse
	}

	const paymentRequiredHeader = initialResponse.headers.get('PAYMENT-REQUIRED')
	if (paymentRequiredHeader === null) {
		return initialResponse
	}

	const challenge = decodeBase64Json<ChallengePayload>(paymentRequiredHeader)
	const workerOrigin = options.workerOrigin ?? new URL(options.resourceUrl).origin
	const ensureFundsUrl = new URL(
		options.ensureFundsPath ?? '/x402/ensure-funds',
		workerOrigin
	).toString()
	const facilitatorUrl = new URL(challenge.facilitatorPath, workerOrigin).toString()

	const ensureFundsResponse = await fetchFn(ensureFundsUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(options.adminToken !== undefined && options.adminToken.trim() !== ''
				? { [DEMO_ADMIN_AUTH_HEADER]: options.adminToken }
				: {}),
		},
		body: JSON.stringify({
			userId: options.userId,
			amountCents: challenge.amountCents,
		}),
	})

	if (!ensureFundsResponse.ok) {
		return ensureFundsResponse
	}

	const facilitatorResponse = await fetchFn(facilitatorUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(options.adminToken !== undefined && options.adminToken.trim() !== ''
				? { [DEMO_ADMIN_AUTH_HEADER]: options.adminToken }
				: {}),
		},
		body: JSON.stringify({
			challengeId: challenge.challengeId,
		}),
	})

	if (!facilitatorResponse.ok) {
		return facilitatorResponse
	}

	const settlement = (await facilitatorResponse.json()) as { receiptId: string }
	const retryHeaders = new Headers(options.requestInit?.headers)
	retryHeaders.set(
		'PAYMENT-SIGNATURE',
		encodeBase64Json({
			challengeId: challenge.challengeId,
			receiptId: settlement.receiptId,
		} satisfies PaymentSignaturePayload)
	)

	return fetchFn(options.resourceUrl, {
		...options.requestInit,
		headers: retryHeaders,
	})
}

export function createIntentId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`
}

export function coerceMaxAmount(rawValue?: string): number | null {
	if (rawValue === undefined || rawValue.trim() === '') {
		return null
	}

	const parsed = Number.parseInt(rawValue, 10)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return null
	}

	return parsed
}

export function enforceMaxAmount(amountCents: number, maxAmountCents: number | null): void {
	if (maxAmountCents !== null && amountCents > maxAmountCents) {
		throw new Error(`Amount exceeds configured maximum of ${maxAmountCents} cents`)
	}
}

export function createTxHash(prefix: string): string {
	void prefix
	const cleaned = crypto.randomUUID().replaceAll('-', '')
	return `0x${cleaned.padEnd(64, '0').slice(0, 64)}`
}

export function encodeBase64Json(value: unknown): string {
	const json = JSON.stringify(value)
	return Buffer.from(json, 'utf8').toString('base64')
}

export function decodeBase64Json<T>(value: string): T {
	return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T
}
