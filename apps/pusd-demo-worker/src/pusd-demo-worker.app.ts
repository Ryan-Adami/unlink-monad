import { Hono } from 'hono'

import { createColumnClient } from '@repo/column-client'
import type { ColumnBankAccount } from '@repo/column-client'
import {
	burnFromTreasury,
	burnPusdOnchain,
	depositMintedToPrivate,
	exitPrivateToPayer,
	exitPrivateToTreasury,
	getMonadAccountAddress,
	mintPusdOnchain,
	mintToTreasury,
	settleX402Payment,
} from '@repo/monad-client'
import {
	coerceMaxAmount,
	createIntentId,
	createTxHash,
	DEFAULT_DEMO_PRICE_CENTS,
	DEMO_ADMIN_AUTH_HEADER,
	decodeBase64Json,
	encodeBase64Json,
	enforceMaxAmount,
	EnsureFundsRequestSchema,
	FacilitatorSettlementSchema,
	type FundingIntentStatus,
	type MintIntentStatus,
	MintRequestSchema,
	type ChallengePayload,
	type PaymentResponsePayload,
	type PaymentSignaturePayload,
	TOKEN_NAME,
	TOKEN_STANDARD,
	TOKEN_SYMBOL,
	MONAD_CAIP2,
	MONAD_TESTNET_CHAIN_ID,
	BurnRequestSchema,
	type BurnIntentStatus,
} from '@repo/pusd-domain'
import { createMockUnlinkClient, createRemoteUnlinkClient } from '@repo/unlink-client'
import type { UnlinkClient } from '@repo/unlink-client'

import type { App } from './context'
import { UnlinkContainer } from './unlink-container'

interface SystemRow {
	id: string
	reserve_cents: number
	ops_cents: number
	total_supply_cents: number
	treasury_public_pusd_cents: number
	payer_public_pusd_cents: number
}

interface UserRow {
	user_id: string
	column_account_id: string
	unlink_wallet_id: string
	fiat_cents: number
	private_pusd_cents: number
}

interface MintIntentRow {
	id: string
	user_id: string
	amount_cents: number
	status: MintIntentStatus
	column_transfer_id: string | null
	tx_hash: string | null
	unlink_operation_id: string | null
	error: string | null
}

interface BurnIntentRow {
	id: string
	user_id: string
	amount_cents: number
	status: BurnIntentStatus
	column_transfer_id: string | null
	tx_hash: string | null
	unlink_operation_id: string | null
	error: string | null
}

interface FundingIntentRow {
	id: string
	user_id: string
	amount_cents: number
	status: FundingIntentStatus
	source_mint_intent_id: string | null
	challenge_id: string | null
	error: string | null
}

interface ChallengeRow {
	id: string
	amount_cents: number
	status: string
	receipt_id: string | null
}

interface LiveColumnPlatformRow {
	id: string
	reserve_entity_id: string
	reserve_bank_account_id: string
	reserve_account_number_id: string
	ops_entity_id: string
	ops_bank_account_id: string
	ops_account_number_id: string
}

interface LiveColumnUserRow {
	user_id: string
	entity_id: string
	bank_account_id: string
	account_number_id: string
	seeded_amount_cents: number
}

interface LiveColumnSmokeResult {
	reserveEntityId: string
	reserveBankAccountId: string
	reserveAccountNumberId: string
	userEntityId: string
	userBankAccountId: string
	userAccountNumberId: string
	simulatedWireAmountCents: number
	bookTransferAmountCents: number
	userBalanceAfterFundingCents: number
	userBalanceAfterTransferCents: number
	reserveBalanceAfterTransferCents: number
	bookTransferId: string
}

interface UnlinkSmokeResult {
	mode: 'mock' | 'container'
	userId: string
	walletId: string
	address: string
	sdkAvailable: boolean
	fallbackUsed: boolean
	error?: string
}

const app = new Hono<App>()
const MONAD_SOCIALSCAN_BASE_URL = 'https://monad-testnet.socialscan.io'
const PUBLIC_DEMO_ADMIN_TOKEN = 'DOyBwfEI08JiYVdNMtkNOMtZfa-27rwFbaD2ffpvQso'

const schemaStatements = [
	`CREATE TABLE IF NOT EXISTS system_state (
		id TEXT PRIMARY KEY,
		reserve_cents INTEGER NOT NULL,
		ops_cents INTEGER NOT NULL,
		total_supply_cents INTEGER NOT NULL,
		treasury_public_pusd_cents INTEGER NOT NULL,
		payer_public_pusd_cents INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS users (
		user_id TEXT PRIMARY KEY,
		column_account_id TEXT NOT NULL,
		unlink_wallet_id TEXT NOT NULL,
		fiat_cents INTEGER NOT NULL,
		private_pusd_cents INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS mint_intents (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		amount_cents INTEGER NOT NULL,
		status TEXT NOT NULL,
		column_transfer_id TEXT,
		tx_hash TEXT,
		unlink_operation_id TEXT,
		error TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS burn_intents (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		amount_cents INTEGER NOT NULL,
		status TEXT NOT NULL,
		column_transfer_id TEXT,
		tx_hash TEXT,
		unlink_operation_id TEXT,
		error TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS x402_funding_intents (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		amount_cents INTEGER NOT NULL,
		status TEXT NOT NULL,
		source_mint_intent_id TEXT,
		challenge_id TEXT,
		error TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS x402_challenges (
		id TEXT PRIMARY KEY,
		amount_cents INTEGER NOT NULL,
		status TEXT NOT NULL,
		receipt_id TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS column_live_state (
		id TEXT PRIMARY KEY,
		reserve_entity_id TEXT NOT NULL,
		reserve_bank_account_id TEXT NOT NULL,
		reserve_account_number_id TEXT NOT NULL,
		ops_entity_id TEXT NOT NULL,
		ops_bank_account_id TEXT NOT NULL,
		ops_account_number_id TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS column_live_users (
		user_id TEXT PRIMARY KEY,
		entity_id TEXT NOT NULL,
		bank_account_id TEXT NOT NULL,
		account_number_id TEXT NOT NULL,
		seeded_amount_cents INTEGER NOT NULL
	)`,
] as const

const resetStatements = [
	`DELETE FROM mint_intents`,
	`DELETE FROM burn_intents`,
	`DELETE FROM x402_funding_intents`,
	`DELETE FROM x402_challenges`,
	`DELETE FROM column_live_users`,
	`DELETE FROM column_live_state`,
	`DELETE FROM users`,
	`DELETE FROM system_state`,
] as const

async function ensureSchema(db: D1Database): Promise<void> {
	for (const statement of schemaStatements) {
		await db.prepare(statement).run()
	}
}

async function resetState(db: D1Database): Promise<void> {
	await ensureSchema(db)
	for (const statement of resetStatements) {
		await db.prepare(statement).run()
	}
}

async function ensureSystemState(db: D1Database): Promise<void> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO system_state (
				id,
				reserve_cents,
				ops_cents,
				total_supply_cents,
				treasury_public_pusd_cents,
				payer_public_pusd_cents
			) VALUES ('singleton', 0, 0, 0, 0, 0)`
		)
		.run()
}

async function ensureUser(
	db: D1Database,
	userId: string,
	initialFiatCents: number,
	env: App['Bindings']
): Promise<void> {
	const existing = await db
		.prepare(`SELECT user_id FROM users WHERE user_id = ?1`)
		.bind(userId)
		.first<{ user_id: string }>()
	if (existing !== null) {
		return
	}

	const unlinkClient = createUnlinkClient(env)
	const wallet = await unlinkClient.createManagedWallet(userId)
	let columnAccountId = `column_${userId}`

	if (currentColumnMode(env.COLUMN_MODE) === 'live') {
		const liveUser = await ensureLiveColumnUser(env, db, userId, initialFiatCents)
		columnAccountId = liveUser.bank_account_id
	}

	await db
		.prepare(
			`INSERT OR IGNORE INTO users (
				user_id,
				column_account_id,
				unlink_wallet_id,
				fiat_cents,
				private_pusd_cents
			) VALUES (?1, ?2, ?3, ?4, 0)`
		)
		.bind(userId, columnAccountId, wallet.walletId, initialFiatCents)
		.run()
}

async function loadSystem(db: D1Database): Promise<SystemRow> {
	const row = await db.prepare(`SELECT * FROM system_state WHERE id = 'singleton'`).first<SystemRow>()
	if (row === null) {
		throw new Error('System state is missing')
	}
	return row
}

async function loadUser(db: D1Database, userId: string): Promise<UserRow> {
	const row = await db.prepare(`SELECT * FROM users WHERE user_id = ?1`).bind(userId).first<UserRow>()
	if (row === null) {
		throw new Error(`Unknown user: ${userId}`)
	}
	return row
}

async function saveSystem(db: D1Database, state: SystemRow): Promise<void> {
	await db
		.prepare(
			`UPDATE system_state
			 SET reserve_cents = ?1,
			     ops_cents = ?2,
			     total_supply_cents = ?3,
			     treasury_public_pusd_cents = ?4,
			     payer_public_pusd_cents = ?5
			 WHERE id = 'singleton'`
		)
		.bind(
			state.reserve_cents,
			state.ops_cents,
			state.total_supply_cents,
			state.treasury_public_pusd_cents,
			state.payer_public_pusd_cents
		)
		.run()
}

async function saveUser(db: D1Database, user: UserRow): Promise<void> {
	await db
		.prepare(
			`UPDATE users
			 SET column_account_id = ?1,
			     unlink_wallet_id = ?2,
			     fiat_cents = ?3,
			     private_pusd_cents = ?4
			 WHERE user_id = ?5`
		)
		.bind(
			user.column_account_id,
			user.unlink_wallet_id,
			user.fiat_cents,
			user.private_pusd_cents,
			user.user_id
		)
		.run()
}

function extractBuyerProductLabel(message: string): string {
	const firstClause = message
		.split(/[.!?]/, 1)[0]
		.replace(/^\s*(hey|hi|hello)\b[\s,:-]*/i, '')

	const cleaned = firstClause
		.replace(/\?.*$/g, '')
		.replace(/\b(i want to buy|i want|i need|help me buy|find me|looking for|recommend)\b/gi, '')
		.replace(/\bunder\s+\$?\d+(?:\.\d{1,2})?\b/gi, '')
		.replace(/\bfor\s+\$?\d+(?:\.\d{1,2})?\b/gi, '')
		.replace(/\b(?:please|thanks|thank you)\b/gi, '')
		.replace(/[.,;:!?]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim()

	if (cleaned === '') {
		return 'recommended item'
	}

	return cleaned.replace(/^[a-z]/, (char) => char.toUpperCase())
}

function parseBuyerBudgetCents(message: string): number | null {
	const match = message.match(/\b(?:under|below|less than|for|around|max(?:imum)?(?: of)?|budget(?: of)?)\s+\$?(\d+(?:\.\d{1,2})?)/i)
	if (match === null) {
		return null
	}

	const dollars = Number.parseFloat(match[1])
	if (!Number.isFinite(dollars) || dollars <= 0) {
		return null
	}

	return Math.round(dollars * 100)
}

function makeDemoCheckoutSlug(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)

	return slug === '' ? 'featured-item' : slug
}

function hashString32(value: string): number {
	let hash = 2166136261
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

function deterministicIntInclusive(min: number, max: number, key: string): number {
	if (max <= min) {
		return min
	}

	const span = max - min + 1
	return min + (hashString32(key) % span)
}

function createDynamicDemoOffer(message: string, fallbackPriceCents: number): {
	productLabel: string
	priceCents: number
	finalChargeCents: number
	discountCents: number
	checkoutLink: string
} {
	const productLabel = extractBuyerProductLabel(message)
	const budgetCents = parseBuyerBudgetCents(message)
	const minCents = budgetCents !== null ? Math.max(99, Math.floor(budgetCents * 0.45)) : Math.max(99, Math.floor(fallbackPriceCents * 0.8))
	const maxCents = budgetCents !== null ? Math.max(minCents, budgetCents - 1) : Math.max(minCents, Math.floor(fallbackPriceCents * 1.8))
	const offerKey = `${productLabel.toLowerCase()}|${budgetCents ?? 'none'}|${fallbackPriceCents}`
	const priceCents = deterministicIntInclusive(minCents, maxCents, `${offerKey}|price`)
	const maxDiscountCents = Math.min(
		priceCents - 1,
		Math.min(75, Math.max(10, Math.floor(priceCents * 0.18)))
	)
	const minDiscountCents = Math.min(maxDiscountCents, Math.max(5, Math.floor(priceCents * 0.05)))
	const discountCents =
		maxDiscountCents > 0
			? deterministicIntInclusive(minDiscountCents, maxDiscountCents, `${offerKey}|discount`)
			: 0
	const finalChargeCents = Math.max(1, priceCents - discountCents)
	const checkoutToken = hashString32(`${offerKey}|checkout`).toString(36).slice(0, 6)
	const checkoutLink = `https://merchant.example/checkout/${makeDemoCheckoutSlug(productLabel)}-${checkoutToken}`

	return {
		productLabel,
		priceCents,
		finalChargeCents,
		discountCents,
		checkoutLink,
	}
}

async function ensureReady(c: { env: App['Bindings'] }, userId: string): Promise<void> {
	const initialFiat = Number.parseInt(c.env.DEMO_INITIAL_USER_FIAT_CENTS, 10)
	await ensureSchema(c.env.DB)
	await ensureSystemState(c.env.DB)
	if (currentColumnMode(c.env.COLUMN_MODE) === 'live') {
		await ensureLiveColumnPlatform(c.env, c.env.DB)
	}
	await ensureUser(
		c.env.DB,
		userId,
		Number.isFinite(initialFiat) ? initialFiat : 500000,
		c.env
	)
}

function currentMaxAmount(rawValue: string): number | null {
	return coerceMaxAmount(rawValue)
}

function currentColumnMode(rawValue: string): 'mock' | 'live' {
	return rawValue === 'live' ? 'live' : 'mock'
}

function currentUnlinkMode(rawValue: string): 'mock' | 'container' {
	return rawValue === 'container' ? 'container' : 'mock'
}

function createConfiguredColumnClient(env: App['Bindings']) {
	return createColumnClient({
		mode: currentColumnMode(env.COLUMN_MODE),
		apiKey: env.COLUMN_SANDBOX_API_KEY,
	})
}

function hasExplicitAccountId(rawValue: string | undefined, placeholder: string): boolean {
	const value = rawValue?.trim()
	return value !== undefined && value !== '' && value !== placeholder
}

function createContainerRequest(
	env: App['Bindings']
): ((path: string, init: RequestInit) => Promise<Response>) | null {
	const baseUrl = env.UNLINK_SERVICE_BASE_URL?.trim()
	if (baseUrl !== undefined && baseUrl !== '') {
		return (path, init) => fetch(new URL(path, baseUrl), init)
	}

	const binding = env.UNLINK_CONTAINER
	if (binding === undefined) {
		return null
	}

	const instanceName = env.UNLINK_CONTAINER_INSTANCE?.trim() || 'singleton'
	const container = binding.getByName(instanceName)
	return (path, init) => container.fetch(new URL(path, 'http://container').toString(), init)
}

function createUnlinkClient(env: App['Bindings']): UnlinkClient {
	if (currentUnlinkMode(env.UNLINK_MODE) === 'mock') {
		return createMockUnlinkClient()
	}

	const request = createContainerRequest(env)
	if (request === null) {
		throw new Error(
			'UNLINK_MODE=container requires UNLINK_SERVICE_BASE_URL or UNLINK_CONTAINER binding'
		)
	}

	return createRemoteUnlinkClient({
		authToken: env.UNLINK_INTERNAL_AUTH_TOKEN,
		request,
		additionalHeaders: {
			'x-unlink-token-address': env.PUSD_TOKEN_ADDRESS,
			'x-unlink-token-decimals': env.PUSD_TOKEN_DECIMALS,
			'x-unlink-chain-rpc-url': env.MONAD_RPC_URL,
		},
	})
}

function parseTokenDecimals(rawValue: string | undefined): number {
	const parsed = Number.parseInt(rawValue ?? '', 10)
	return Number.isFinite(parsed) ? parsed : 18
}

function hasLivePusdConfig(env: App['Bindings']): boolean {
	return (
		currentUnlinkMode(env.UNLINK_MODE) === 'container' &&
		(env.UNLINK_DEPOSITOR_PRIVATE_KEY?.trim() ?? '') !== '' &&
		(env.PUSD_TOKEN_ADDRESS?.trim() ?? '') !== ''
	)
}

function shouldUseAsyncIntentFlow(env: App['Bindings']): boolean {
	return (
		currentColumnMode(env.COLUMN_MODE) === 'live' ||
		currentUnlinkMode(env.UNLINK_MODE) === 'container' ||
		hasLivePusdConfig(env)
	)
}

function shouldWaitForIntent(c: { env: App['Bindings']; req: { query(name: string): string | undefined } }): boolean {
	return c.req.query('wait') === 'true'
}

function requireProtectedRouteAuth(c: {
	env: App['Bindings']
	req: { header(name: string): string | undefined }
	json: (body: unknown, status?: number) => Response
}): Response | null {
	const expectedToken = c.env.DEMO_ADMIN_TOKEN?.trim() ?? ''
	if (expectedToken === '') {
		return c.json({ error: 'DEMO_ADMIN_TOKEN is required' }, 503)
	}

	const providedToken = c.req.header(DEMO_ADMIN_AUTH_HEADER)?.trim() ?? ''
	if (providedToken === '' || providedToken !== expectedToken) {
		return c.json({ error: 'Unauthorized' }, 401)
	}

	return null
}

function currentTreasuryAddress(env: App['Bindings']): `0x${string}` {
	if (hasLivePusdConfig(env)) {
		return getMonadAccountAddress(env.UNLINK_DEPOSITOR_PRIVATE_KEY!.trim() as `0x${string}`)
	}

	return env.TREASURY_WALLET_ADDRESS as `0x${string}`
}

function assertInvariant(system: SystemRow): void {
	if (system.reserve_cents < system.total_supply_cents) {
		throw new Error('Reserve backing invariant violated')
	}
}

async function loadLiveColumnPlatform(
	db: D1Database
): Promise<LiveColumnPlatformRow | null> {
	return db
		.prepare(`SELECT * FROM column_live_state WHERE id = 'singleton'`)
		.first<LiveColumnPlatformRow>()
}

async function ensureLiveColumnPlatform(
	env: App['Bindings'],
	db: D1Database
): Promise<LiveColumnPlatformRow> {
	const existing = await loadLiveColumnPlatform(db)
	if (existing !== null) {
		return existing
	}

	const explicitReserveId = hasExplicitAccountId(env.RESERVE_ACCOUNT_ID, 'reserve_bank_account')
		? env.RESERVE_ACCOUNT_ID.trim()
		: null
	const explicitOpsId = hasExplicitAccountId(env.OPS_ACCOUNT_ID, 'ops_bank_account')
		? env.OPS_ACCOUNT_ID.trim()
		: null

	let reserveEntityId = 'configured'
	let reserveBankAccountId = explicitReserveId ?? ''
	let reserveAccountNumberId = explicitReserveId === null ? '' : 'configured'
	let opsEntityId = 'configured'
	let opsBankAccountId = explicitOpsId ?? ''
	let opsAccountNumberId = explicitOpsId === null ? '' : 'configured'

	if (explicitReserveId === null || explicitOpsId === null) {
		const columnClient = createConfiguredColumnClient(env)
		if (columnClient.createBusinessEntity === undefined || columnClient.createBankAccount === undefined) {
			throw new Error('Live Column platform provisioning requires entity and bank account APIs')
		}

		const address = createDemoAddress()
		const suffix = crypto.randomUUID().slice(0, 8)
		const platformEntity = await columnClient.createBusinessEntity({
			businessName: `PUSD Platform ${suffix}`,
			ein: createDemoDigits(9),
			address,
		})

		if (explicitReserveId === null) {
			const reserveBankAccount = await columnClient.createBankAccount({
				entityId: platformEntity.id,
				description: `PUSD reserve ${suffix}`,
			})
			reserveEntityId = platformEntity.id
			reserveBankAccountId = reserveBankAccount.id
			reserveAccountNumberId = reserveBankAccount.defaultAccountNumberId
		}

		if (explicitOpsId === null) {
			const opsBankAccount = await columnClient.createBankAccount({
				entityId: platformEntity.id,
				description: `PUSD ops ${suffix}`,
			})
			opsEntityId = platformEntity.id
			opsBankAccountId = opsBankAccount.id
			opsAccountNumberId = opsBankAccount.defaultAccountNumberId
		}
	}

	const row: LiveColumnPlatformRow = {
		id: 'singleton',
		reserve_entity_id: reserveEntityId,
		reserve_bank_account_id: reserveBankAccountId,
		reserve_account_number_id: reserveAccountNumberId,
		ops_entity_id: opsEntityId,
		ops_bank_account_id: opsBankAccountId,
		ops_account_number_id: opsAccountNumberId,
	}

	await db
		.prepare(
			`INSERT INTO column_live_state (
				id,
				reserve_entity_id,
				reserve_bank_account_id,
				reserve_account_number_id,
				ops_entity_id,
				ops_bank_account_id,
				ops_account_number_id
			) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
		)
		.bind(
			row.id,
			row.reserve_entity_id,
			row.reserve_bank_account_id,
			row.reserve_account_number_id,
			row.ops_entity_id,
			row.ops_bank_account_id,
			row.ops_account_number_id
		)
		.run()

	return row
}

async function ensureLiveColumnUser(
	env: App['Bindings'],
	db: D1Database,
	userId: string,
	initialFiatCents: number
): Promise<LiveColumnUserRow> {
	const existing = await db
		.prepare(`SELECT * FROM column_live_users WHERE user_id = ?1`)
		.bind(userId)
		.first<LiveColumnUserRow>()
	if (existing !== null) {
		return existing
	}

	const columnClient = createConfiguredColumnClient(env)
	if (
		columnClient.createPersonEntity === undefined ||
		columnClient.createBankAccount === undefined ||
		columnClient.simulateReceiveWire === undefined ||
		columnClient.getBankAccount === undefined
	) {
		throw new Error('Live Column user provisioning requires person, bank account, and wire APIs')
	}

	const address = createDemoAddress()
	const suffix = `${userId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(0, 12)}${crypto
		.randomUUID()
		.slice(0, 6)}`
	const userEntity = await columnClient.createPersonEntity({
		firstName: 'Demo',
		lastName: suffix || 'User',
		ssn: createDemoDigits(9),
		dateOfBirth: '1990-01-01',
		email: `${suffix || 'demo'}@example.com`,
		phoneNumber: '+14155550123',
		address,
	})
	const userBankAccount = await columnClient.createBankAccount({
		entityId: userEntity.id,
		description: `PUSD user ${userId}`,
	})

	await columnClient.simulateReceiveWire({
		destinationAccountNumberId: userBankAccount.defaultAccountNumberId,
		amountCents: initialFiatCents,
	})

	const fundedAccount = await waitForAvailableBalance(
		columnClient.getBankAccount,
		userBankAccount.id,
		initialFiatCents
	)
	if (fundedAccount.availableAmount < initialFiatCents) {
		throw new Error(`Column user funding did not settle for ${userId}`)
	}

	const row: LiveColumnUserRow = {
		user_id: userId,
		entity_id: userEntity.id,
		bank_account_id: userBankAccount.id,
		account_number_id: userBankAccount.defaultAccountNumberId,
		seeded_amount_cents: initialFiatCents,
	}

	await db
		.prepare(
			`INSERT INTO column_live_users (
				user_id,
				entity_id,
				bank_account_id,
				account_number_id,
				seeded_amount_cents
			) VALUES (?1, ?2, ?3, ?4, ?5)`
		)
		.bind(
			row.user_id,
			row.entity_id,
			row.bank_account_id,
			row.account_number_id,
			row.seeded_amount_cents
		)
		.run()

	return row
}

async function currentReserveAccountId(env: App['Bindings'], db: D1Database): Promise<string> {
	if (currentColumnMode(env.COLUMN_MODE) !== 'live') {
		return env.RESERVE_ACCOUNT_ID
	}

	const platform = await ensureLiveColumnPlatform(env, db)
	return platform.reserve_bank_account_id
}

async function loadMintIntent(db: D1Database, mintIntentId: string): Promise<MintIntentRow> {
	const intent = await db
		.prepare(`SELECT * FROM mint_intents WHERE id = ?1`)
		.bind(mintIntentId)
		.first<MintIntentRow>()
	if (intent === null) {
		throw new Error(`Mint intent not found: ${mintIntentId}`)
	}
	return intent
}

async function loadBurnIntent(db: D1Database, burnIntentId: string): Promise<BurnIntentRow> {
	const intent = await db
		.prepare(`SELECT * FROM burn_intents WHERE id = ?1`)
		.bind(burnIntentId)
		.first<BurnIntentRow>()
	if (intent === null) {
		throw new Error(`Burn intent not found: ${burnIntentId}`)
	}
	return intent
}

async function createMintIntentRecord(
	db: D1Database,
	userId: string,
	amountCents: number
): Promise<string> {
	const mintIntentId = createIntentId('mint')
	await db
		.prepare(
			`INSERT INTO mint_intents (
				id,
				user_id,
				amount_cents,
				status,
				column_transfer_id,
				tx_hash,
				unlink_operation_id,
				error
			) VALUES (?1, ?2, ?3, 'initiated', NULL, NULL, NULL, NULL)`
		)
		.bind(mintIntentId, userId, amountCents)
		.run()
	return mintIntentId
}

async function createBurnIntentRecord(
	db: D1Database,
	userId: string,
	amountCents: number
): Promise<string> {
	const burnIntentId = createIntentId('burn')
	await db
		.prepare(
			`INSERT INTO burn_intents (
				id,
				user_id,
				amount_cents,
				status,
				column_transfer_id,
				tx_hash,
				unlink_operation_id,
				error
			) VALUES (?1, ?2, ?3, 'initiated', NULL, NULL, NULL, NULL)`
		)
		.bind(burnIntentId, userId, amountCents)
		.run()
	return burnIntentId
}

async function processMintIntentById(
	env: App['Bindings'],
	db: D1Database,
	mintIntentId: string
): Promise<{ system: SystemRow; user: UserRow; intent: MintIntentRow }> {
	let intent = await loadMintIntent(db, mintIntentId)
	let user = await loadUser(db, intent.user_id)
	let system = await loadSystem(db)
	const reserveAccountId = await currentReserveAccountId(env, db)
	const columnClient = createConfiguredColumnClient(env)
	const unlinkClient = createUnlinkClient(env)
	let txHash = intent.tx_hash ?? createTxHash('mint')

	if (intent.status === 'completed' || intent.status === 'failed' || intent.status === 'manual_review') {
		return { system, user, intent }
	}

	try {
		if (intent.column_transfer_id === null) {
			if (user.fiat_cents < intent.amount_cents) {
				await db
					.prepare(`UPDATE mint_intents SET status = 'failed', error = ?2 WHERE id = ?1`)
					.bind(mintIntentId, 'Insufficient fiat balance')
					.run()
				throw new Error('Insufficient fiat balance')
			}

			await db
				.prepare(`UPDATE mint_intents SET status = 'book_transfer_pending' WHERE id = ?1`)
				.bind(mintIntentId)
				.run()

			const transfer = await columnClient.createBookTransfer({
				sourceAccountId: user.column_account_id,
				destinationAccountId: reserveAccountId,
				amountCents: intent.amount_cents,
				description: `Mint ${intent.amount_cents} cents for ${user.user_id}`,
			})

			user = {
				...user,
				fiat_cents: user.fiat_cents - intent.amount_cents,
			}
			system = {
				...system,
				reserve_cents: system.reserve_cents + intent.amount_cents,
			}
			await saveUser(db, user)
			await saveSystem(db, system)
			await db
				.prepare(
					`UPDATE mint_intents
					 SET status = 'funds_received',
					     column_transfer_id = ?2
					 WHERE id = ?1`
				)
				.bind(mintIntentId, transfer.transferId)
				.run()
			intent = await loadMintIntent(db, mintIntentId)
		}

		if (intent.tx_hash === null) {
			await db
				.prepare(`UPDATE mint_intents SET status = 'minting' WHERE id = ?1`)
				.bind(mintIntentId)
				.run()

			if (hasLivePusdConfig(env)) {
				txHash = await mintPusdOnchain({
					privateKey: env.UNLINK_DEPOSITOR_PRIVATE_KEY!.trim() as `0x${string}`,
					contractAddress: env.PUSD_TOKEN_ADDRESS!.trim() as `0x${string}`,
					rpcUrl: env.MONAD_RPC_URL?.trim() || undefined,
					tokenDecimals: parseTokenDecimals(env.PUSD_TOKEN_DECIMALS),
					recipient: currentTreasuryAddress(env),
					amountCents: intent.amount_cents,
				})
			}

			system = {
				...system,
				...mapLedgerToSystem(
					system,
					mintToTreasury(
						{
							totalSupplyCents: system.total_supply_cents,
							treasuryPublicPusdCents: system.treasury_public_pusd_cents,
							payerPublicPusdCents: system.payer_public_pusd_cents,
						},
						intent.amount_cents
					)
				),
			}
			await saveSystem(db, system)
			await db
				.prepare(
					`UPDATE mint_intents
					 SET status = 'private_deposit_pending',
					     tx_hash = ?2
					 WHERE id = ?1`
				)
				.bind(mintIntentId, txHash)
				.run()
			intent = await loadMintIntent(db, mintIntentId)
		} else {
			txHash = intent.tx_hash
		}

		if (intent.unlink_operation_id === null) {
			await db
				.prepare(`UPDATE mint_intents SET status = 'private_deposit_pending' WHERE id = ?1`)
				.bind(mintIntentId)
				.run()

			const deposit = await unlinkClient.depositToPrivate({
				walletId: user.unlink_wallet_id,
				amountCents: intent.amount_cents,
			})

			system = mapLedgerToSystem(
				system,
				depositMintedToPrivate(
					{
						totalSupplyCents: system.total_supply_cents,
						treasuryPublicPusdCents: system.treasury_public_pusd_cents,
						payerPublicPusdCents: system.payer_public_pusd_cents,
					},
					intent.amount_cents
				)
			)
			user = {
				...user,
				private_pusd_cents: user.private_pusd_cents + intent.amount_cents,
			}
			assertInvariant(system)
			await saveUser(db, user)
			await saveSystem(db, system)
			await db
				.prepare(
					`UPDATE mint_intents
					 SET status = 'completed',
					     unlink_operation_id = ?2,
					     error = NULL
					 WHERE id = ?1`
				)
				.bind(mintIntentId, deposit.operationId)
				.run()
			intent = await loadMintIntent(db, mintIntentId)
		}

		return {
			system,
			user,
			intent,
		}
	} catch (caughtError) {
		const message =
			caughtError instanceof Error ? caughtError.message : 'Unknown mint processing failure'
		const latest = await loadMintIntent(db, mintIntentId)
		if (latest.status !== 'manual_review' && latest.status !== 'completed') {
			await db
				.prepare(`UPDATE mint_intents SET status = 'failed', error = ?2 WHERE id = ?1`)
				.bind(mintIntentId, message)
				.run()
		}
		throw caughtError
	}
}

async function createEmbeddedMint(
	env: App['Bindings'],
	db: D1Database,
	user: UserRow,
	system: SystemRow,
	amountCents: number,
	reserveAccountId: string
): Promise<{ system: SystemRow; user: UserRow; mintIntentId: string }> {
	void user
	void system
	void reserveAccountId
	const mintIntentId = await createMintIntentRecord(db, user.user_id, amountCents)
	const processed = await processMintIntentById(env, db, mintIntentId)
	return {
		system: processed.system,
		user: processed.user,
		mintIntentId,
	}
}

async function processBurnIntentById(
	env: App['Bindings'],
	db: D1Database,
	burnIntentId: string
): Promise<{ system: SystemRow; user: UserRow; intent: BurnIntentRow }> {
	let intent = await loadBurnIntent(db, burnIntentId)
	let system = await loadSystem(db)
	let user = await loadUser(db, intent.user_id)
	const unlinkClient = createUnlinkClient(env)
	const columnClient = createConfiguredColumnClient(env)
	const reserveAccountId = await currentReserveAccountId(env, db)
	let burnTxHash = intent.tx_hash ?? createTxHash('burn')

	if (intent.status === 'completed' || intent.status === 'failed' || intent.status === 'manual_review') {
		return { system, user, intent }
	}

	try {
		if (intent.unlink_operation_id === null) {
			if (user.private_pusd_cents < intent.amount_cents) {
				await db
					.prepare(`UPDATE burn_intents SET status = 'failed', error = ?2 WHERE id = ?1`)
					.bind(burnIntentId, 'Insufficient private PUSD balance')
					.run()
				throw new Error('Insufficient private PUSD balance')
			}

			await db
				.prepare(`UPDATE burn_intents SET status = 'private_exit_pending' WHERE id = ?1`)
				.bind(burnIntentId)
				.run()

			const privateExit = await unlinkClient.exitToPublic({
				walletId: user.unlink_wallet_id,
				amountCents: intent.amount_cents,
				destination: currentTreasuryAddress(env),
			})

			user = {
				...user,
				private_pusd_cents: user.private_pusd_cents - intent.amount_cents,
			}
			system = mapLedgerToSystem(
				system,
				exitPrivateToTreasury(
					{
						totalSupplyCents: system.total_supply_cents,
						treasuryPublicPusdCents: system.treasury_public_pusd_cents,
						payerPublicPusdCents: system.payer_public_pusd_cents,
					},
					intent.amount_cents
				)
			)
			await saveUser(db, user)
			await saveSystem(db, system)
			await db
				.prepare(
					`UPDATE burn_intents
					 SET status = 'burning',
					     unlink_operation_id = ?2
					 WHERE id = ?1`
				)
				.bind(burnIntentId, privateExit.operationId)
				.run()
			intent = await loadBurnIntent(db, burnIntentId)
		}

		if (intent.tx_hash === null) {
			system = mapLedgerToSystem(
				system,
				burnFromTreasury(
					{
						totalSupplyCents: system.total_supply_cents,
						treasuryPublicPusdCents: system.treasury_public_pusd_cents,
						payerPublicPusdCents: system.payer_public_pusd_cents,
					},
					intent.amount_cents
				)
			)

			if (hasLivePusdConfig(env)) {
				burnTxHash = await burnPusdOnchain({
					privateKey: env.UNLINK_DEPOSITOR_PRIVATE_KEY!.trim() as `0x${string}`,
					contractAddress: env.PUSD_TOKEN_ADDRESS!.trim() as `0x${string}`,
					rpcUrl: env.MONAD_RPC_URL?.trim() || undefined,
					tokenDecimals: parseTokenDecimals(env.PUSD_TOKEN_DECIMALS),
					amountCents: intent.amount_cents,
				})
			}

			await saveSystem(db, system)
			await db
				.prepare(
					`UPDATE burn_intents
					 SET status = 'payout_pending',
					     tx_hash = ?2
					 WHERE id = ?1`
				)
				.bind(burnIntentId, burnTxHash)
				.run()
			intent = await loadBurnIntent(db, burnIntentId)
		} else {
			burnTxHash = intent.tx_hash
		}

		if (intent.column_transfer_id === null) {
			if (system.reserve_cents < intent.amount_cents) {
				await db
					.prepare(`UPDATE burn_intents SET status = 'manual_review', error = ?2 WHERE id = ?1`)
					.bind(burnIntentId, 'Reserve balance too low for payout')
					.run()
				throw new Error('Reserve balance too low for payout')
			}

			await db
				.prepare(`UPDATE burn_intents SET status = 'payout_pending' WHERE id = ?1`)
				.bind(burnIntentId)
				.run()

			const transfer = await columnClient.createBookTransfer({
				sourceAccountId: reserveAccountId,
				destinationAccountId: user.column_account_id,
				amountCents: intent.amount_cents,
				description: `Burn ${intent.amount_cents} cents for ${user.user_id}`,
			})

			system = {
				...system,
				reserve_cents: system.reserve_cents - intent.amount_cents,
			}
			user = {
				...user,
				fiat_cents: user.fiat_cents + intent.amount_cents,
			}
			assertInvariant(system)
			await saveUser(db, user)
			await saveSystem(db, system)
			await db
				.prepare(
					`UPDATE burn_intents
					 SET status = 'completed',
					     column_transfer_id = ?2,
					     error = NULL
					 WHERE id = ?1`
				)
				.bind(burnIntentId, transfer.transferId)
				.run()
			intent = await loadBurnIntent(db, burnIntentId)
		}

		return {
			system,
			user,
			intent,
		}
	} catch (caughtError) {
		const message =
			caughtError instanceof Error ? caughtError.message : 'Unknown burn processing failure'
		const latest = await loadBurnIntent(db, burnIntentId)
		if (latest.status !== 'manual_review' && latest.status !== 'completed') {
			await db
				.prepare(`UPDATE burn_intents SET status = 'failed', error = ?2 WHERE id = ?1`)
				.bind(burnIntentId, message)
				.run()
		}
		throw caughtError
	}
}

function createDemoAddress(): {
	line_1: string
	line_2: string
	city: string
	state: string
	postal_code: string
	country_code: string
} {
	return {
		line_1: '101 Market St',
		line_2: 'Suite 100',
		city: 'San Francisco',
		state: 'CA',
		postal_code: '94105',
		country_code: 'US',
	}
}

function createDemoDigits(length: number): string {
	const seed = crypto.randomUUID().replaceAll('-', '')
	const digits = Array.from(seed)
		.map((character) => (character.charCodeAt(0) % 10).toString())
		.join('')
	return digits.slice(0, length).padEnd(length, '0')
}

async function waitForAvailableBalance(
	columnClient: NonNullable<ReturnType<typeof createColumnClient>['getBankAccount']>,
	bankAccountId: string,
	minimumAmountCents: number
): Promise<ColumnBankAccount> {
	let latest = await columnClient(bankAccountId)

	for (let attempt = 0; attempt < 10; attempt += 1) {
		if (latest.availableAmount >= minimumAmountCents) {
			return latest
		}

		await new Promise((resolve) => setTimeout(resolve, 500))
		latest = await columnClient(bankAccountId)
	}

	return latest
}

async function runLiveColumnSmoke(
	apiKey: string,
	fundingAmountCents: number,
	transferAmountCents: number
): Promise<LiveColumnSmokeResult> {
	const columnClient = createColumnClient({
		mode: 'live',
		apiKey,
	})
	const address = createDemoAddress()
	const suffix = crypto.randomUUID().slice(0, 8)

	const reserveEntity = await columnClient.createBusinessEntity!({
		businessName: `PUSD Reserve ${suffix}`,
		ein: createDemoDigits(9),
		address,
	})
	const reserveBankAccount = await columnClient.createBankAccount!({
		entityId: reserveEntity.id,
		description: `Reserve account ${suffix}`,
	})

	const userEntity = await columnClient.createPersonEntity!({
		firstName: 'Olivia',
		lastName: `Demo${suffix}`,
		ssn: createDemoDigits(9),
		dateOfBirth: '1988-08-04',
		email: `olivia.${suffix}@example.com`,
		phoneNumber: '+14155550100',
		address,
	})
	const userBankAccount = await columnClient.createBankAccount!({
		entityId: userEntity.id,
		description: `User account ${suffix}`,
	})

	await columnClient.simulateReceiveWire!({
		destinationAccountNumberId: userBankAccount.defaultAccountNumberId,
		amountCents: fundingAmountCents,
	})

	const fundedUserAccount = await waitForAvailableBalance(
		columnClient.getBankAccount!,
		userBankAccount.id,
		fundingAmountCents
	)

	if (fundedUserAccount.availableAmount < transferAmountCents) {
		throw new Error('Simulated wire did not settle in time for the smoke transfer')
	}

	const bookTransfer = await columnClient.createBookTransfer({
		sourceAccountId: userBankAccount.id,
		destinationAccountId: reserveBankAccount.id,
		amountCents: transferAmountCents,
		description: `Smoke transfer ${suffix}`,
	})
	const userAfterTransfer = await columnClient.getBankAccount!(userBankAccount.id)
	const reserveAfterTransfer = await columnClient.getBankAccount!(reserveBankAccount.id)

	return {
		reserveEntityId: reserveEntity.id,
		reserveBankAccountId: reserveBankAccount.id,
		reserveAccountNumberId: reserveBankAccount.defaultAccountNumberId,
		userEntityId: userEntity.id,
		userBankAccountId: userBankAccount.id,
		userAccountNumberId: userBankAccount.defaultAccountNumberId,
		simulatedWireAmountCents: fundingAmountCents,
		bookTransferAmountCents: transferAmountCents,
		userBalanceAfterFundingCents: fundedUserAccount.availableAmount,
		userBalanceAfterTransferCents: userAfterTransfer.availableAmount,
		reserveBalanceAfterTransferCents: reserveAfterTransfer.availableAmount,
		bookTransferId: bookTransfer.transferId,
	}
}

function mapLedgerToSystem(system: SystemRow, ledger: ReturnType<typeof mintToTreasury>): SystemRow {
	return {
		...system,
		total_supply_cents: ledger.totalSupplyCents,
		treasury_public_pusd_cents: ledger.treasuryPublicPusdCents,
		payer_public_pusd_cents: ledger.payerPublicPusdCents,
	}
}

async function parseJson<T>(request: Request): Promise<T> {
	return (await request.json()) as T
}

function renderTerminalDemoUi(options?: {
	initialAdminToken?: string
	initialUserId?: string
	autoplay?: boolean
}): string {
	const initialAdminToken = options?.initialAdminToken ?? PUBLIC_DEMO_ADMIN_TOKEN
	const initialUserId = options?.initialUserId ?? 'judge-demo'
	const autoplay = options?.autoplay ?? false

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>PUSD Demo Console</title>
		<style>
			:root {
				--bg: #07110d;
				--bg-soft: #0d1914;
				--panel: rgba(7, 18, 13, 0.9);
				--panel-soft: rgba(11, 25, 19, 0.86);
				--line: rgba(81, 255, 179, 0.14);
				--line-strong: rgba(81, 255, 179, 0.28);
				--text: #d7ffe8;
				--muted: #81d8a7;
				--green: #51ffb3;
				--amber: #ffd86b;
				--red: #ff7b7b;
				--shadow: 0 22px 70px rgba(0, 0, 0, 0.42);
			}

			* {
				box-sizing: border-box;
			}

			body {
				margin: 0;
				min-height: 100vh;
				font-family: "IBM Plex Mono", "JetBrains Mono", "SFMono-Regular", ui-monospace, monospace;
				color: var(--text);
				background:
					radial-gradient(circle at top right, rgba(81, 255, 179, 0.08), transparent 32%),
					radial-gradient(circle at bottom left, rgba(255, 216, 107, 0.07), transparent 28%),
					linear-gradient(180deg, #040807 0%, #07110d 45%, #030705 100%);
			}

			body::before {
				content: "";
				position: fixed;
				inset: 0;
				pointer-events: none;
				background-image: linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px);
				background-size: 100% 4px;
				opacity: 0.08;
			}

			.shell {
				max-width: 1360px;
				margin: 0 auto;
				padding: 28px;
			}

			.header {
				display: grid;
				grid-template-columns: repeat(2, minmax(0, 1fr));
				gap: 20px;
				margin-bottom: 20px;
				align-items: stretch;
			}

			.panel {
				position: relative;
				border: 1px solid var(--line);
				background: var(--panel);
				border-radius: 18px;
				box-shadow: var(--shadow);
				overflow: hidden;
			}

			.panel::after {
				content: "";
				position: absolute;
				inset: 0;
				pointer-events: none;
				border-top: 1px solid rgba(255, 255, 255, 0.03);
				background: linear-gradient(180deg, rgba(81, 255, 179, 0.04), transparent 18%);
			}

			.titlebar {
				display: flex;
				align-items: center;
				justify-content: space-between;
				padding: 14px 18px;
				border-bottom: 1px solid var(--line);
				background: rgba(255, 255, 255, 0.018);
				font-size: 12px;
				text-transform: uppercase;
				letter-spacing: 0.12em;
			}

			.dots {
				display: inline-flex;
				gap: 8px;
			}

			.dot {
				width: 10px;
				height: 10px;
				border-radius: 50%;
				background: rgba(255, 255, 255, 0.18);
			}

			.dot.green {
				background: var(--green);
			}

			.dot.amber {
				background: var(--amber);
			}

			.content {
				padding: 20px;
			}

			h1, h2, p {
				margin: 0;
			}

			.hero {
				display: grid;
				gap: 14px;
				min-height: 100%;
				align-content: start;
			}

			.kicker {
				color: var(--green);
				font-size: 12px;
				text-transform: uppercase;
				letter-spacing: 0.18em;
			}

			h1 {
				font-size: clamp(32px, 5vw, 58px);
				line-height: 0.92;
				letter-spacing: -0.03em;
			}

			.subtle {
				color: var(--muted);
				font-size: 14px;
				line-height: 1.7;
				max-width: 58ch;
			}

			.layout {
				display: grid;
				grid-template-columns: repeat(2, minmax(0, 1fr));
				grid-template-areas:
					'chat proof'
					'side side'
					'skill skill';
				gap: 20px;
				align-items: stretch;
			}

			.layout > * {
				min-width: 0;
			}

			.chat-shell {
				grid-area: chat;
				display: grid;
				grid-template-rows: auto auto auto 1fr auto;
				height: 820px;
				min-height: 820px;
			}

			.summary-strip {
				display: grid;
				grid-template-columns: repeat(3, minmax(0, 1fr));
				gap: 10px;
				padding: 16px 20px;
				border-bottom: 1px solid var(--line);
				background: rgba(255, 255, 255, 0.016);
				align-items: start;
			}

			.summary-chip {
				padding: 12px;
				border: 1px solid var(--line);
				border-radius: 12px;
				background: rgba(255, 255, 255, 0.018);
				min-height: 82px;
			}

			.summary-chip .label {
				display: block;
				color: var(--muted);
				font-size: 11px;
				text-transform: uppercase;
				letter-spacing: 0.12em;
				margin-bottom: 6px;
			}

			.summary-chip .value {
				display: block;
				font-size: 18px;
				color: var(--text);
			}

			.stage-strip {
				display: grid;
				grid-template-columns: repeat(5, minmax(0, 1fr));
				gap: 4px;
				padding: 0 12px 12px;
				border-bottom: 1px solid var(--line);
				background: rgba(255, 255, 255, 0.016);
				align-items: start;
			}

			.stage-pill {
				padding: 7px 4px 8px;
				border-radius: 999px;
				border: 1px solid var(--line);
				background: rgba(255, 255, 255, 0.018);
				text-align: center;
				display: grid;
				gap: 2px;
				min-width: 0;
			}

			.stage-pill .name {
				font-size: 8px;
				text-transform: uppercase;
				letter-spacing: 0.1em;
				color: var(--muted);
				line-height: 1.1;
				white-space: nowrap;
			}

			.stage-pill .state {
				font-size: 9px;
				color: var(--text);
				line-height: 1.15;
				overflow-wrap: anywhere;
			}

			.stage-pill.pending {
				opacity: 0.78;
			}

			.stage-pill.active {
				border-color: rgba(255, 216, 107, 0.32);
				background: rgba(255, 216, 107, 0.08);
			}

			.stage-pill.active .state {
				color: var(--amber);
			}

			.stage-pill.done {
				border-color: rgba(81, 255, 179, 0.28);
				background: rgba(81, 255, 179, 0.08);
			}

			.stage-pill.done .state {
				color: var(--green);
			}

			.chat-thread {
				padding: 18px 20px;
				overflow: auto;
				display: grid;
				align-content: start;
				gap: 12px;
				background:
					linear-gradient(180deg, rgba(255, 255, 255, 0.01), transparent 12%),
					linear-gradient(180deg, rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.02));
			}

			.bubble {
				max-width: 88%;
				padding: 14px 16px;
				border-radius: 16px;
				border: 1px solid var(--line);
				background: var(--panel-soft);
				display: grid;
				gap: 8px;
				box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
			}

			.bubble.user {
				justify-self: end;
				background: rgba(81, 255, 179, 0.07);
				border-color: rgba(81, 255, 179, 0.22);
			}

			.bubble.agent {
				justify-self: start;
			}

			.bubble.system {
				justify-self: start;
				border-style: dashed;
			}

			.bubble.loading {
				justify-self: start;
				border-style: dashed;
				border-color: rgba(255, 216, 107, 0.24);
				background: rgba(255, 216, 107, 0.05);
			}

			.bubble .meta {
				font-size: 11px;
				text-transform: uppercase;
				letter-spacing: 0.12em;
				color: var(--muted);
			}

			.bubble .text {
				font-size: 14px;
				line-height: 1.7;
				color: var(--text);
			}

			.bubble .subtext {
				font-size: 12px;
				line-height: 1.6;
				color: var(--muted);
				word-break: break-word;
			}

			.bubble.loading .meta::after {
				content: " · thinking";
				color: var(--amber);
			}

			.chat-compose {
				padding: 18px 20px 20px;
				border-top: 1px solid var(--line);
				display: grid;
				gap: 12px;
			}

			.chat-actions {
				display: grid;
				grid-template-columns: repeat(2, minmax(0, 1fr));
				gap: 10px;
			}

			.tool-stack {
				grid-area: side;
				display: flex;
				flex-direction: column;
				height: 820px;
				min-height: 820px;
			}

			.tool-stack > .panel {
				flex: 1 1 auto;
				min-height: 100%;
				display: grid;
				grid-template-rows: auto 1fr;
			}

			.tool-stack > .panel .content {
				display: grid;
				align-content: start;
				height: 100%;
			}

			.stack {
				display: grid;
				gap: 12px;
			}

			.control-stack {
				display: flex;
				flex-direction: column;
				gap: 12px;
				height: 100%;
				min-height: 0;
			}

			.control-stack .button-grid {
				align-content: start;
				grid-auto-rows: minmax(56px, auto);
			}

			.control-stack .note {
				margin-top: auto;
			}

			label {
				display: grid;
				gap: 8px;
				font-size: 12px;
				text-transform: uppercase;
				letter-spacing: 0.12em;
				color: var(--muted);
			}

			input,
			textarea {
				width: 100%;
				padding: 13px 14px;
				border-radius: 10px;
				border: 1px solid var(--line);
				background: rgba(0, 0, 0, 0.26);
				color: var(--text);
				font: inherit;
				outline: none;
			}

			input:focus,
			textarea:focus {
				border-color: var(--line-strong);
				box-shadow: 0 0 0 3px rgba(81, 255, 179, 0.08);
			}

			textarea {
				min-height: 120px;
				resize: vertical;
			}

			button {
				appearance: none;
				border: 1px solid var(--line);
				border-radius: 10px;
				min-height: 56px;
				padding: 12px 14px;
				background: rgba(81, 255, 179, 0.05);
				color: var(--text);
				font: inherit;
				text-align: center;
				cursor: pointer;
				transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
			}

			button:hover {
				transform: translateY(-1px);
				background: rgba(81, 255, 179, 0.08);
				border-color: rgba(81, 255, 179, 0.32);
			}

			button.primary {
				background: linear-gradient(135deg, rgba(81, 255, 179, 0.16), rgba(255, 216, 107, 0.08));
				border-color: rgba(81, 255, 179, 0.24);
			}

			button:disabled {
				opacity: 0.5;
				cursor: not-allowed;
				transform: none;
			}

			.button-grid {
				display: grid;
				grid-template-columns: repeat(2, minmax(0, 1fr));
				gap: 10px;
			}

			.button-grid .primary {
				grid-column: 1 / -1;
			}

			.button-grid .full {
				grid-column: 1 / -1;
			}

			.legend {
				font-size: 12px;
				line-height: 1.7;
				color: var(--muted);
			}

			.terminal {
				grid-area: proof;
				height: 820px;
				min-height: 820px;
				max-height: 820px;
				display: grid;
				grid-template-rows: auto 1fr;
			}

			.terminal .log {
				height: 100%;
				min-height: 0;
			}

			.skill-panel {
				grid-area: skill;
			}

			.skill-list {
				display: grid;
				grid-template-columns: repeat(5, minmax(0, 1fr));
				gap: 10px;
			}

			.skill-item {
				padding: 14px;
				border: 1px solid var(--line);
				border-radius: 12px;
				background: rgba(255, 255, 255, 0.018);
				display: grid;
				gap: 8px;
			}

			.skill-item .step {
				font-size: 11px;
				text-transform: uppercase;
				letter-spacing: 0.12em;
				color: var(--green);
			}

			.skill-item .body {
				font-size: 12px;
				line-height: 1.65;
				color: var(--text);
			}

			.log {
				padding: 18px 20px 26px;
				overflow: auto;
				font-size: 13px;
				line-height: 1.7;
				white-space: pre-wrap;
				word-break: break-word;
				background:
					linear-gradient(180deg, rgba(255, 255, 255, 0.01), transparent 12%),
					linear-gradient(180deg, rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.02));
			}

			.log a {
				color: #8fdcff;
				text-decoration: underline;
				text-decoration-color: rgba(143, 220, 255, 0.55);
				text-underline-offset: 2px;
			}

			.log a:hover {
				color: #c8efff;
			}

			.line {
				display: block;
				margin-bottom: 8px;
			}

			.line.info {
				color: var(--text);
			}

			.line.ok {
				color: var(--green);
			}

			.line.warn {
				color: var(--amber);
			}

			.line.err {
				color: var(--red);
			}

			.cursor {
				display: inline-block;
				width: 10px;
				height: 1.1em;
				background: var(--green);
				vertical-align: text-bottom;
				margin-left: 6px;
				animation: blink 1s steps(2, start) infinite;
			}

			@keyframes blink {
				to { opacity: 0; }
			}

			.note {
				margin-top: 14px;
				padding-top: 14px;
				border-top: 1px dashed var(--line);
				color: var(--muted);
				font-size: 12px;
				line-height: 1.6;
			}

			@media (max-width: 980px) {
				.layout,
				.summary-strip,
				.stage-strip,
				.chat-actions,
				.button-grid,
				.skill-list {
					grid-template-columns: 1fr;
				}

				.layout {
					grid-template-columns: 1fr;
					grid-template-areas:
						'chat'
						'proof'
						'side'
						'skill';
				}

				.button-grid .primary {
					grid-column: auto;
				}

				.chat-shell {
					height: auto;
					min-height: 0;
				}

				.tool-stack {
					height: auto;
					min-height: 0;
				}

				.tool-stack > .panel {
					min-height: 0;
				}

				.terminal {
					height: 480px;
					min-height: 480px;
					max-height: none;
				}
			}
		</style>
	</head>
	<body>
		<div class="shell">
			<section class="layout">
				<div class="panel chat-shell">
					<div class="titlebar">
						<span>Buyer Chat</span>
						<span>${TOKEN_SYMBOL} / ${TOKEN_STANDARD} / Chain ${MONAD_TESTNET_CHAIN_ID}</span>
					</div>
					<div class="summary-strip">
						<div class="summary-chip">
							<span class="label">Bank Cash</span>
							<span class="value" id="summaryCash">Not Linked</span>
							</div>
							<div class="summary-chip">
								<span class="label">Private USD</span>
								<span class="value" id="summaryPrivate">$0.00</span>
						</div>
						<div class="summary-chip">
							<span class="label">Purchase Status</span>
							<span class="value" id="summaryCheckout">Waiting</span>
						</div>
					</div>
					<div class="stage-strip">
						<div class="stage-pill pending" id="stageBank">
							<span class="name">Bank</span>
							<span class="state">Pending</span>
						</div>
						<div class="stage-pill pending" id="stageAgent">
							<span class="name">Agent</span>
							<span class="state">Pending</span>
						</div>
						<div class="stage-pill pending" id="stagePrivate">
							<span class="name">Private</span>
							<span class="state">Pending</span>
						</div>
						<div class="stage-pill pending" id="stagePay">
							<span class="name">Pay</span>
							<span class="state">Pending</span>
						</div>
						<div class="stage-pill pending" id="stageCashout">
							<span class="name">Cashout</span>
							<span class="state">Pending</span>
						</div>
					</div>
					<div class="chat-thread" id="chatThread" aria-live="polite"></div>
					<div class="chat-compose">
						<label>
							Message The Shopping Agent
							<textarea id="buyerMessage" autocomplete="off" placeholder="Example: I want to buy a lightweight travel backpack under $80.">I want to buy a lightweight travel backpack under $80.</textarea>
						</label>
						<div class="chat-actions">
							<button class="primary" id="askAgent">Send Message</button>
						</div>
						<div class="note">
							Use normal chat to ask for something to buy. Use slash commands for manual control: <code>/system-info</code>, <code>/link-cash</code>, <code>/check-balances</code>, <code>/approve-purchase</code>, <code>/cash-out</code>, <code>/reset-demo</code>, <code>/run-demo</code>.
						</div>
					</div>
				</div>
				<div class="tool-stack">
					<div class="panel">
						<div class="titlebar">
							<span>Controls</span>
							<span>Operator Rail</span>
						</div>
						<div class="content stack control-stack">
							<label>
								Buyer Name
								<input id="userId" type="text" autocomplete="off" value="jane-doe" />
							</label>
							<div class="button-grid">
								<button class="primary" id="guidedDemo">Run Full Buyer Demo</button>
								<button class="full" id="resetState">Reset Everything (Fresh Demo Start)</button>
								<button class="full" id="clearLog">Clear Live Event Stream</button>
								<button class="full" id="showPublic">1. Show Live System</button>
								<button id="setupBuyer">2. Connect Cash Account</button>
								<button id="showBalances">3. View Balances</button>
								<button id="burnFunds">4. Cash Out Leftover</button>
							</div>
							<div class="note">
								Use the left panel as the real product experience. Use this rail only when you need to reset the demo, inspect balances, or pause and explain a step.
							</div>
						</div>
					</div>
				</div>
				<div class="panel terminal">
					<div class="titlebar">
						<span>Proof Rail</span>
						<span><span id="statusText">Ready</span><span class="cursor"></span></span>
					</div>
					<div class="log" id="log" role="log" aria-live="polite"></div>
				</div>
				<div class="panel skill-panel">
					<div class="titlebar">
						<span>Agent Skill</span>
						<span>Chat-Driven Policy</span>
					</div>
						<div class="content stack">
							<p class="legend">This is the decision policy the shopping agent follows during the demo. The chat drives the story; the proof rail shows the real banking and onchain evidence underneath it.</p>
						<div class="skill-list">
							<div class="skill-item">
								<span class="step">Step 1</span>
								<div class="body">Read the buyer message. If it is shopping intent, quote a product, price, and checkout path.</div>
							</div>
							<div class="skill-item">
								<span class="step">Step 2</span>
								<div class="body">Ask for approval inside the chat. The buyer then explicitly replies with <code>/approve-purchase</code> or a natural yes.</div>
							</div>
							<div class="skill-item">
								<span class="step">Step 3</span>
								<div class="body">Check the buyer’s private USD. If low, move cash by Column book transfer, mint PUSD on Monad, and deposit into Unlink.</div>
							</div>
							<div class="skill-item">
								<span class="step">Step 4</span>
								<div class="body">Fund the shared payer path, settle the x402 challenge, and retry the checkout request automatically.</div>
							</div>
							<div class="skill-item">
								<span class="step">Step 5</span>
								<div class="body">If value remains, burn the leftover private USD back into cash so the buyer ends settled and clean.</div>
							</div>
						</div>
						<div class="note">
							The x402 settlement remains intentionally labeled <code>demo-ledger</code>. The banking, mint, private movement, and burn steps remain real.
						</div>
					</div>
				</div>
			</section>
		</div>

		<script>
			const userIdInput = document.getElementById('userId')
			const buyerMessageInput = document.getElementById('buyerMessage')
			const chatThread = document.getElementById('chatThread')
			const log = document.getElementById('log')
			const statusText = document.getElementById('statusText')
			const summaryCash = document.getElementById('summaryCash')
			const summaryPrivate = document.getElementById('summaryPrivate')
			const summaryCheckout = document.getElementById('summaryCheckout')
			const stageBank = document.getElementById('stageBank')
			const stageAgent = document.getElementById('stageAgent')
			const stagePrivate = document.getElementById('stagePrivate')
			const stagePay = document.getElementById('stagePay')
			const stageCashout = document.getElementById('stageCashout')
			const initialConfig = {
				adminToken: ${JSON.stringify(initialAdminToken)},
				userId: ${JSON.stringify(initialUserId)},
				autoplay: ${autoplay ? 'true' : 'false'},
			}

			const state = {
				busy: false,
				adminToken: initialConfig.adminToken || PUBLIC_DEMO_ADMIN_TOKEN,
				autoplayStarted: false,
				lastOffer: null,
				buyerReady: false,
				awaitingConfirmation: false,
				pendingShoppingMessage: null,
			}

			userIdInput.value = initialConfig.userId || userIdInput.value

			userIdInput.addEventListener('input', () => {
				if (state.busy) {
					return
				}
				void syncSummaryFromServer()
			})

			buyerMessageInput.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' || event.shiftKey) {
					return
				}
				event.preventDefault()
				if (state.busy) {
					return
				}
				withBusy('Chat', handleChatSubmit)
			})

			function setStatus(value) {
				statusText.textContent = value
			}

			function setCheckoutStatus(value) {
				summaryCheckout.textContent = value
			}

			function setStage(element, status, label) {
				element.className = 'stage-pill ' + status
				element.querySelector('.state').textContent = label
			}

			function resetStages() {
				setStage(stageBank, 'pending', 'Pending')
				setStage(stageAgent, 'pending', 'Pending')
				setStage(stagePrivate, 'pending', 'Pending')
				setStage(stagePay, 'pending', 'Pending')
				setStage(stageCashout, 'pending', 'Pending')
			}

			function setSummaryBalances(fiatCents, privatePusdCents) {
				if (typeof fiatCents === 'number' && Number.isFinite(fiatCents)) {
					summaryCash.textContent = centsToUsd(fiatCents)
				} else {
					summaryCash.textContent = 'Not Linked'
				}
				summaryPrivate.textContent = centsToUsd(privatePusdCents)
			}

			function appendChatBubble(kind, title, text, extra) {
				const bubble = document.createElement('div')
				bubble.className = 'bubble ' + kind

				const meta = document.createElement('div')
				meta.className = 'meta'
				meta.textContent = title
				bubble.appendChild(meta)

				const main = document.createElement('div')
				main.className = 'text'
				main.textContent = text
				bubble.appendChild(main)

				if (extra !== undefined && extra !== '') {
					const sub = document.createElement('div')
					sub.className = 'subtext'
					appendLinkedSegments(sub, extra)
					bubble.appendChild(sub)
				}

				chatThread.appendChild(bubble)
				chatThread.scrollTop = chatThread.scrollHeight
				return bubble
			}

			function appendPendingAgentBubble() {
				return appendChatBubble(
					'loading',
					'AI Shopping Agent',
					'Thinking through the request...',
					'Using the Cloudflare AI binding to route the next action.'
				)
			}

			function appendLoadingBubble(title, text, extra) {
				return appendChatBubble('loading', title, text, extra)
			}

			function resetChatThread() {
				chatThread.replaceChildren()
				resetStages()
				setCheckoutStatus('Waiting')
			}

			function monadExplorerLink(value) {
				if (/^0x[a-fA-F0-9]{64}$/.test(value)) {
					return '${MONAD_SOCIALSCAN_BASE_URL}/tx/' + value
				}
				if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
					return '${MONAD_SOCIALSCAN_BASE_URL}/address/' + value
				}
				if (/^https?:\\/\\//.test(value)) {
					return value
				}
				return null
			}

			function appendLinkedSegments(parent, text) {
				const source = String(text)
				const regex = /(https?:\\/\\/\\S+|0x[a-fA-F0-9]{64}|0x[a-fA-F0-9]{40})/g
				let lastIndex = 0
				for (const match of source.matchAll(regex)) {
					const index = match.index ?? 0
					if (index > lastIndex) {
						parent.appendChild(document.createTextNode(source.slice(lastIndex, index)))
					}
					const value = match[0]
					const href = monadExplorerLink(value)
					if (href === null) {
						parent.appendChild(document.createTextNode(value))
					} else {
						const anchor = document.createElement('a')
						anchor.href = href
						anchor.target = '_blank'
						anchor.rel = 'noreferrer noopener'
						anchor.textContent = value
						parent.appendChild(anchor)
					}
					lastIndex = index + value.length
				}
				if (lastIndex < source.length) {
					parent.appendChild(document.createTextNode(source.slice(lastIndex)))
				}
			}

			function appendJsonLike(parent, value, depth = 0) {
				const indent = '  '.repeat(depth)
				if (value === null) {
					parent.appendChild(document.createTextNode('null'))
					return
				}
				if (typeof value === 'string') {
					parent.appendChild(document.createTextNode('"'))
					appendLinkedSegments(parent, value)
					parent.appendChild(document.createTextNode('"'))
					return
				}
				if (typeof value === 'number' || typeof value === 'boolean') {
					parent.appendChild(document.createTextNode(String(value)))
					return
				}
				if (Array.isArray(value)) {
					parent.appendChild(document.createTextNode('[\\n'))
					value.forEach((entry, index) => {
						parent.appendChild(document.createTextNode('  '.repeat(depth + 1)))
						appendJsonLike(parent, entry, depth + 1)
						parent.appendChild(document.createTextNode(index === value.length - 1 ? '\\n' : ',\\n'))
					})
					parent.appendChild(document.createTextNode(indent + ']'))
					return
				}
				if (typeof value === 'object') {
					const entries = Object.entries(value)
					parent.appendChild(document.createTextNode('{\\n'))
					entries.forEach(([key, entry], index) => {
						parent.appendChild(document.createTextNode('  '.repeat(depth + 1) + key + ': '))
						appendJsonLike(parent, entry, depth + 1)
						parent.appendChild(document.createTextNode(index === entries.length - 1 ? '\\n' : ',\\n'))
					})
					parent.appendChild(document.createTextNode(indent + '}'))
					return
				}
				parent.appendChild(document.createTextNode(String(value)))
			}

			function writeLine(kind, message, data) {
				const line = document.createElement('span')
				line.className = 'line ' + kind
				line.appendChild(document.createTextNode('> ' + message))
				if (data !== undefined) {
					line.appendChild(document.createTextNode(' '))
					appendJsonLike(line, data)
				}
				log.appendChild(line)
				log.scrollTop = log.scrollHeight
			}

			function clearLog() {
				log.replaceChildren()
			}

			function sleep(ms) {
				return new Promise((resolve) => setTimeout(resolve, ms))
			}

			function getUserId() {
				return userIdInput.value.trim() || 'jane-doe'
			}

			function getBuyerMessage() {
				return buyerMessageInput.value.trim()
			}

			function canonicalCommand(value) {
				switch (value) {
					case '/info':
					case '/system-info':
						return '/system-info'
					case '/buyer':
					case '/link-cash':
						return '/link-cash'
					case '/balances':
					case '/check-balances':
						return '/check-balances'
					case '/confirm':
					case '/approve-purchase':
						return '/approve-purchase'
					case '/cashout':
					case '/cash-out':
						return '/cash-out'
					case '/reset':
					case '/reset-demo':
						return '/reset-demo'
					case '/demo':
					case '/run-demo':
						return '/run-demo'
					default:
						return value
				}
			}

			function getAdminToken() {
				const token = state.adminToken.trim()
				if (token === '') {
					throw new Error('Demo admin token is not configured')
				}
				return token
			}

			async function parseJson(response) {
				const text = await response.text()
				if (text === '') {
					return null
				}
				try {
					return JSON.parse(text)
				} catch {
					return text
				}
			}

			function encodeBase64Json(value) {
				return btoa(unescape(encodeURIComponent(JSON.stringify(value))))
			}

			function decodeBase64Json(value) {
				return JSON.parse(decodeURIComponent(escape(atob(value))))
			}

			function centsToUsd(cents) {
				return '$' + (cents / 100).toFixed(2)
			}

			async function request(path, options = {}, requiresAuth = false) {
				const headers = new Headers(options.headers || {})
				if (requiresAuth) {
					headers.set('${DEMO_ADMIN_AUTH_HEADER}', getAdminToken())
				}

				const response = await fetch(path, {
					...options,
					headers,
				})
				const body = await parseJson(response)
				if (!response.ok) {
					throw new Error(typeof body === 'string' ? body : JSON.stringify(body))
				}
				return { response, body }
			}

			async function getBalances() {
				const { body } = await request('/balances?userId=' + encodeURIComponent(getUserId()), {}, true)
				return body
			}

			async function pollIntent(pollPath, label) {
				for (let attempt = 1; attempt <= 8; attempt += 1) {
					writeLine('info', label + ' poll #' + attempt)
					const { body } = await request(pollPath, {}, true)
					const intent = body.intent
					writeLine('info', label + ' status', {
						status: intent.status,
						columnTransferId: intent.column_transfer_id,
						txHash: intent.tx_hash,
						unlinkOperationId: intent.unlink_operation_id,
					})
					if (['completed', 'failed', 'manual_review'].includes(intent.status)) {
						return intent
					}
					await sleep(1500)
				}
				throw new Error(label + ' did not reach a terminal state in time')
			}

			async function withBusy(label, fn) {
				if (state.busy) {
					return
				}
				state.busy = true
				setStatus(label)
				try {
					await fn()
					setStatus('Ready')
				} catch (error) {
					writeLine('err', label + ' failed', {
						error: error instanceof Error ? error.message : String(error),
					})
					setStatus('Failed')
				} finally {
					state.busy = false
				}
			}

			async function syncSummaryFromServer() {
				if (state.adminToken.trim() === '') {
					return
				}
				try {
					const { body } = await request('/balances?create=0&userId=' + encodeURIComponent(getUserId()), {}, true)
					if (body.user === null) {
						state.buyerReady = false
						setSummaryBalances(null, 0)
						if (summaryCheckout.textContent !== 'Paid') {
							setCheckoutStatus('Waiting')
						}
						return
					}
						setSummaryBalances(body.user.fiatCents, body.user.privatePusdCents)
					setStage(stageBank, 'done', 'Linked')
					if (body.user.privatePusdCents > 0) {
						setStage(stagePrivate, 'done', 'Ready')
					} else if (stagePrivate.classList.contains('done')) {
						setStage(stagePrivate, 'pending', 'Pending')
					}
				} catch {
					// Keep the UI usable even if auth is missing or the request fails.
				}
			}

			async function showPublic() {
				const { body } = await request('/demo/public')
				writeLine('ok', 'Live system info', body)
				setStage(stageBank, 'active', 'Ready')
				appendChatBubble(
					'system',
					'System',
					'The live rails are ready: this demo uses Column for bank accounts, Unlink for private balances, and Monad for token settlement.',
					'Treasury: ' + body.onchainRails.treasuryWallet + ' | PUSD token: ' + body.token.address
				)
			}

			async function resetState() {
				clearLog()
				resetChatThread()
				writeLine('info', 'Resetting the browser view and server-side demo state')
				const { body } = await request('/admin/reset', {
					method: 'POST',
				}, true)
				state.lastOffer = null
				state.buyerReady = false
				state.awaitingConfirmation = false
				state.pendingShoppingMessage = null
				setSummaryBalances(null, 0)
				setCheckoutStatus('Waiting')
				writeLine('ok', 'Demo state reset', body)
				writeLine('ok', 'Fresh start ready. Begin with step 1.')
			}

			async function setupBuyer() {
				const { body } = await request('/admin/demo-buyer', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						userId: getUserId(),
					}),
				}, true)
				setSummaryBalances(body.buyer.startingCashCents, 0)
				state.buyerReady = true
				setCheckoutStatus('Ready')
				setStage(stageBank, 'done', 'Linked')
				writeLine('ok', 'Buyer account is linked and funded', body)
				appendChatBubble(
					'system',
					'Linked Cash Account',
					'Your new buyer is ready with ' + body.buyer.startingCashUsd + ' in a linked cash balance.',
					'Bank account: ' + body.buyer.linkedBankAccountId + ' | Private wallet: ' + body.buyer.privateWalletId
				)
				if (typeof state.pendingShoppingMessage === 'string' && state.pendingShoppingMessage !== '') {
					const pendingMessage = state.pendingShoppingMessage
					state.pendingShoppingMessage = null
					appendChatBubble(
						'agent',
						'AI Shopping Agent',
						'Your cash account is linked now. I am continuing your last shopping request and preparing a quote.',
						'Next: I will re-check your last request and return the checkout quote.'
					)
					await askAgent(pendingMessage)
				}
			}

			async function showBalances() {
				const body = await getBalances()
				setSummaryBalances(body.user.fiatCents, body.user.privatePusdCents)
				if (body.user.privatePusdCents <= 0 && summaryCheckout.textContent !== 'Paid') {
					setCheckoutStatus('Waiting')
				}
				writeLine('ok', 'Balance snapshot', body)
				appendChatBubble(
					'system',
					'Balance Check',
					'Cash: ' + centsToUsd(body.user.fiatCents) + ' | Private USD: ' + centsToUsd(body.user.privatePusdCents),
					body.user.privatePusdCents > 0
						? 'The buyer now has private spending power without holding a public token balance.'
						: 'The buyer is still starting from cash only.'
				)
			}

			async function askAgent(customMessage) {
				const message = customMessage ?? getBuyerMessage()
				if (message === '') {
					throw new Error('Enter a shopping question first')
				}

				if (customMessage === undefined) {
					appendChatBubble('user', 'Buyer', message)
				}
				writeLine('info', 'Buyer asks', {
					userId: getUserId(),
					message,
				})
				const pendingBubble = appendPendingAgentBubble()

				let body
				try {
					const response = await request('/demo/assistant', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							userId: getUserId(),
							message,
						}),
					})
					body = response.body
				} finally {
					pendingBubble.remove()
				}

				state.awaitingConfirmation = body.requiresConfirmation === true
				state.lastOffer = state.awaitingConfirmation ? body : null
				state.pendingShoppingMessage = body.suggestedAction === '/link-cash' ? message : null
				setStage(stageAgent, 'done', 'Quoted')
				writeLine('ok', 'AI shopping agent reply', body)
				const detailParts = []
				if (typeof body.checkoutLink === 'string' && body.checkoutLink !== '') {
					detailParts.push('Checkout link: ' + body.checkoutLink)
				}
				if (typeof body.priceCents === 'number') {
					detailParts.push('Price: ' + centsToUsd(body.priceCents))
				}
				if (typeof body.suggestedAction === 'string' && body.suggestedAction !== '') {
					detailParts.push('Suggested next step: ' + body.suggestedAction)
				}
				appendChatBubble(
					'agent',
					'AI Shopping Agent',
					body.reply,
					detailParts.join(' | ')
				)
				if (body.requiresConfirmation) {
					setCheckoutStatus('Awaiting OK')
				} else if (body.suggestedAction === '/link-cash') {
					setCheckoutStatus('Link Cash')
				} else {
					setCheckoutStatus('Waiting')
				}
			}

			async function runPurchaseFlow(options = {}) {
				if (state.lastOffer === null) {
					appendChatBubble(
						'agent',
						'AI Shopping Agent',
						'There is no active quote to approve yet.',
						'Ask for a product first, then approve it with /approve-purchase.'
					)
					return
				}

				const { appendConfirmationBubble = true, confirmationText = 'Yes, go ahead and buy it.' } = options
				const offer = state.lastOffer
				const quotedAmountCents = offer.priceCents
				const checkoutAmountCents =
					typeof offer.finalChargeCents === 'number' ? offer.finalChargeCents : offer.priceCents
				const discountCents = Math.max(0, quotedAmountCents - checkoutAmountCents)
				const startingBalances = await getBalances()
				setSummaryBalances(startingBalances.user.fiatCents, startingBalances.user.privatePusdCents)
				setStage(stagePay, 'active', 'Paying')
				if (appendConfirmationBubble) {
					appendChatBubble(
						'user',
						'Buyer',
						confirmationText,
						'The agent will check whether private USD already exists before paying.'
					)
				}
				writeLine('info', 'Buyer confirms the purchase', {
					quotedPrice: centsToUsd(quotedAmountCents),
					checkoutPrice: centsToUsd(checkoutAmountCents),
					discount: centsToUsd(discountCents),
					privateUsdBefore: centsToUsd(startingBalances.user.privatePusdCents),
				})

				const targetPrivateBalanceCents = offer.targetPrivateBalanceCents
				if (startingBalances.user.privatePusdCents < targetPrivateBalanceCents) {
					setStage(stagePrivate, 'active', 'Minting')
					const topUpAmountCents = targetPrivateBalanceCents - startingBalances.user.privatePusdCents
					writeLine('info', 'Private balance is low, converting cash into Private USD', {
						topUpAmountCents,
						topUpAmountUsd: centsToUsd(topUpAmountCents),
					})
					const mintingBubble = appendLoadingBubble(
						'AI Shopping Agent',
						'Converting bank cash into private USD...',
						'This moves cash into reserve, mints PUSD on Monad, and deposits it into Unlink.'
					)
					try {
						const { body } = await request('/mint-intents', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								userId: getUserId(),
								amountCents: topUpAmountCents,
							}),
						}, true)
						writeLine('info', 'Cash to PUSD conversion started', body.intent)
						const intent = body.async ? await pollIntent(body.pollPath, 'Cash to PUSD') : body.intent
						writeLine('ok', 'Private USD is ready', intent)
						const postMintBalances = await getBalances()
						setSummaryBalances(postMintBalances.user.fiatCents, postMintBalances.user.privatePusdCents)
						setStage(stagePrivate, 'done', 'Ready')
						appendChatBubble(
							'system',
							'Private Conversion',
							'Cash was converted into private USD only after the buyer approved the purchase, and only for the exact quoted amount.',
							'Quoted amount: ' + centsToUsd(quotedAmountCents) + ' | Column transfer: ' + intent.column_transfer_id + ' | Mint tx: ' + intent.tx_hash
						)
					} finally {
						mintingBubble.remove()
					}
				} else {
					writeLine('ok', 'Buyer already has enough Private USD', {
						privateUsdAvailable: centsToUsd(startingBalances.user.privatePusdCents),
					})
					setStage(stagePrivate, 'done', 'Ready')
					appendChatBubble(
						'system',
						'Private Balance Ready',
						'The buyer already has enough private USD, so no additional minting is needed.',
						'Available private USD: ' + centsToUsd(startingBalances.user.privatePusdCents)
					)
				}

				setCheckoutStatus('Paying')
				const checkoutBubble = appendLoadingBubble(
					'AI Shopping Agent',
					'Completing the private checkout...',
					'Funding the payer path, satisfying the x402 challenge, and retrying the purchase.'
				)
				try {
					const payResponse = await fetch('/demo/paid?amountCents=' + String(checkoutAmountCents))
					if (payResponse.status !== 402) {
						throw new Error('Expected 402 from /demo/paid')
					}
					const challengeHeader = payResponse.headers.get('PAYMENT-REQUIRED')
					if (!challengeHeader) {
						throw new Error('PAYMENT-REQUIRED header missing')
					}
					const challenge = decodeBase64Json(challengeHeader)
					writeLine('warn', 'Checkout link requested payment', challenge)

					await request('/x402/ensure-funds', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							userId: getUserId(),
							amountCents: challenge.amountCents,
						}),
					}, true)
					writeLine('ok', 'Agent used the payment skill to move private dollars into the payer path', {
						amountUsd: centsToUsd(challenge.amountCents),
					})
					const postFundingBalances = await getBalances()
					setSummaryBalances(postFundingBalances.user.fiatCents, postFundingBalances.user.privatePusdCents)

					const { body: settleBody } = await request('/facilitator/settle', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							challengeId: challenge.challengeId,
						}),
					}, true)
					writeLine('ok', 'Checkout challenge settled', settleBody)

					const signature = encodeBase64Json({
						challengeId: challenge.challengeId,
						receiptId: settleBody.receiptId,
					})
					const paidResponse = await fetch('/demo/paid?amountCents=' + String(checkoutAmountCents), {
						headers: {
							'PAYMENT-SIGNATURE': signature,
						},
					})
					if (!paidResponse.ok) {
						throw new Error(await paidResponse.text())
					}
					const paymentResponse = decodeBase64Json(paidResponse.headers.get('PAYMENT-RESPONSE'))
					const paidBody = await paidResponse.json()
					writeLine('ok', 'Checkout request succeeded', {
						paidBody,
						paymentResponse,
					})
					setCheckoutStatus('Paid')
					setStage(stagePay, 'done', 'Paid')
					appendChatBubble(
						'system',
						'Checkout Complete',
						discountCents > 0
							? 'The agent completed the purchase and found a last-minute discount at checkout.'
							: 'The agent completed the purchase through the x402 checkout path.',
						'Receipt: ' + paymentResponse.receiptId + ' | Charged: ' + centsToUsd(checkoutAmountCents) + ' | Discount: ' + centsToUsd(discountCents)
					)
					state.lastOffer = null
					state.awaitingConfirmation = false

					const updatedBalances = await getBalances()
					setSummaryBalances(updatedBalances.user.fiatCents, updatedBalances.user.privatePusdCents)
					writeLine('ok', 'Balance snapshot', updatedBalances)
					appendChatBubble(
						'system',
						'After Purchase',
						'The buyer now has ' + centsToUsd(updatedBalances.user.privatePusdCents) + ' left as private USD after checkout.',
						updatedBalances.user.privatePusdCents > 0
							? 'That leftover can be burned back into cash.'
							: 'There is no leftover private balance to redeem.'
					)
				} finally {
					checkoutBubble.remove()
				}
			}

			async function cashOutLeftover() {
				const balances = await getBalances()
				setSummaryBalances(balances.user.fiatCents, balances.user.privatePusdCents)
				if (balances.user.privatePusdCents <= 0) {
					writeLine('warn', 'There is no leftover Private USD to cash out', balances)
					setStage(stageCashout, 'done', 'Skipped')
					appendChatBubble(
						'system',
						'No Cash-Out Needed',
						'There is no remaining private USD to redeem.',
						'The buyer is already back to cash only.'
					)
					return
				}

				setStage(stageCashout, 'active', 'Burning')
				writeLine('info', 'Cashing the leftover Private USD back into the linked bank account', {
					remainingPrivateUsd: centsToUsd(balances.user.privatePusdCents),
				})
				const cashoutBubble = appendLoadingBubble(
					'AI Shopping Agent',
					'Redeeming the leftover private balance...',
					'Withdrawing from Unlink, burning PUSD on Monad, and returning the cash to the bank account.'
				)
				let updatedBalances

				try {
					const { body } = await request('/burn-intents', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							userId: getUserId(),
							amountCents: balances.user.privatePusdCents,
						}),
					}, true)
					writeLine('info', 'Cash-out started', body.intent)
					const intent = body.async ? await pollIntent(body.pollPath, 'Cash-out') : body.intent
					writeLine('ok', 'Leftover Private USD is back in cash', intent)
					appendChatBubble(
						'system',
						'Cash-Out Complete',
						'The leftover private USD was burned and returned to the linked cash account.',
						'Burn tx: ' + intent.tx_hash + ' | Payout transfer: ' + intent.column_transfer_id
					)
					updatedBalances = await getBalances()
					setSummaryBalances(updatedBalances.user.fiatCents, updatedBalances.user.privatePusdCents)
					setCheckoutStatus('Settled')
					setStage(stageCashout, 'done', 'Done')
				} finally {
					cashoutBubble.remove()
				}
				if (updatedBalances) {
					writeLine('ok', 'Balance snapshot', updatedBalances)
					appendChatBubble(
						'system',
						'Finished Cleanly',
						'The buyer ends with cash again and no outstanding private USD.',
						'Cash: ' + centsToUsd(updatedBalances.user.fiatCents) + ' | Private USD: ' + centsToUsd(updatedBalances.user.privatePusdCents)
					)
				}
			}

			async function runGuidedDemo() {
				writeLine('info', '--- Buyer demo start ---')
				await resetState()
				await showPublic()
				await setupBuyer()
				await showBalances()
				await askAgent()
				await runPurchaseFlow()
				await cashOutLeftover()
				writeLine('ok', '--- Buyer demo complete ---')
			}

			async function handleChatSubmit() {
				const message = getBuyerMessage()
				if (message === '') {
					throw new Error('Enter a message first')
				}

				appendChatBubble('user', 'Buyer', message)
				buyerMessageInput.value = ''
				const normalized = message.trim().toLowerCase()
				const command = canonicalCommand(normalized)

				if (command === '/help') {
					appendChatBubble(
						'agent',
						'AI Shopping Agent',
						'Available commands: /system-info (show the live rails), /link-cash (connect the buyer bank account), /check-balances, /approve-purchase, /cash-out, /reset-demo, /run-demo.',
						'Any normal message is treated as a shopping request.'
					)
					return
				}

				if (command === '/system-info') {
					await showPublic()
					return
				}

				if (command === '/link-cash') {
					await setupBuyer()
					return
				}

				if (command === '/check-balances') {
					await showBalances()
					return
				}

				if (command === '/cash-out') {
					await cashOutLeftover()
					return
				}

				if (command === '/reset-demo') {
					await resetState()
					return
				}

				if (command === '/run-demo') {
					await runGuidedDemo()
					return
				}

				const naturalConfirmation = /^(yes|yes please|go ahead|buy it|do it|confirm)$/i.test(message.trim())
				if (
					(command === '/approve-purchase' && state.awaitingConfirmation) ||
					(state.awaitingConfirmation && naturalConfirmation)
				) {
					await runPurchaseFlow({
						appendConfirmationBubble: false,
						confirmationText: message,
					})
					return
				}

				if (command === '/approve-purchase' && !state.awaitingConfirmation) {
					appendChatBubble(
						'agent',
						'AI Shopping Agent',
						'There is no quoted item to approve yet.',
						'Ask me to find something to buy first, then approve that quote with /approve-purchase.'
					)
					return
				}

				await askAgent(message)
			}

			document.getElementById('showPublic').addEventListener('click', () => withBusy('System Info', showPublic))
			document.getElementById('resetState').addEventListener('click', () => withBusy('Reset', resetState))
			document.getElementById('clearLog').addEventListener('click', () => {
				clearLog()
				writeLine('ok', 'Live event stream cleared.')
			})
			document.getElementById('setupBuyer').addEventListener('click', () => withBusy('Create Buyer', setupBuyer))
			document.getElementById('askAgent').addEventListener('click', () => withBusy('Chat', handleChatSubmit))
			document.getElementById('showBalances').addEventListener('click', () => withBusy('Balances', showBalances))
			document.getElementById('burnFunds').addEventListener('click', () => withBusy('Cash Out', cashOutLeftover))
			document.getElementById('guidedDemo').addEventListener('click', () => withBusy('Buyer Demo', runGuidedDemo))

			resetChatThread()
			setSummaryBalances(null, 0)
			setCheckoutStatus('Waiting')
			writeLine('ok', 'Demo ready. Start in chat, use slash commands for manual control, or run the full buyer demo.')
			void syncSummaryFromServer()

			if (initialConfig.autoplay) {
				writeLine('warn', 'Autoplay enabled. The buyer demo will start automatically in 1.2s.')
				setTimeout(() => {
					if (state.autoplayStarted) {
						return
					}
					state.autoplayStarted = true
					withBusy('Buyer Demo', runGuidedDemo)
				}, 1200)
			}
		</script>
	</body>
</html>`
}

app.get('/demo/public', async (c) => {
	const treasuryWallet = currentTreasuryAddress(c.env)
	const sharedPayerWallet = c.env.SHARED_PAYER_WALLET

	return c.json({
		name: 'PUSD Hackathon Demo Worker',
		chainId: MONAD_TESTNET_CHAIN_ID,
		explorerBaseUrl: MONAD_SOCIALSCAN_BASE_URL,
		token: {
			name: TOKEN_NAME,
			symbol: TOKEN_SYMBOL,
			standard: TOKEN_STANDARD,
			address: c.env.PUSD_TOKEN_ADDRESS,
		},
		onchainRails: {
			treasuryWallet,
			sharedPayerWallet,
		},
		privateFlow: {
			note: 'The public deposit and withdrawal boundary transactions are clickable proof onchain. The private balance movement in between is intentionally not visible on a block explorer; you prove it by showing the app balance changes and the successful private spend.',
		},
	})
})

app.post('/demo/assistant', async (c) => {
	const payload = await parseJson<unknown>(c.req.raw)
	const userId =
		typeof payload === 'object' &&
		payload !== null &&
		'userId' in payload &&
		typeof payload.userId === 'string' &&
		payload.userId.trim() !== ''
			? payload.userId.trim()
			: 'jane-doe'
	const userMessage =
		typeof payload === 'object' &&
		payload !== null &&
		'message' in payload &&
		typeof payload.message === 'string'
			? payload.message.trim()
			: ''

	if (userMessage === '') {
		return c.json({ error: 'A shopping question is required' }, 400)
	}

	if (c.env.AI === undefined) {
		return c.json({ error: 'Cloudflare AI binding is unavailable' }, 503)
	}

	const priceCents = Number.parseInt(c.env.DEMO_PRICE_CENTS, 10) || DEFAULT_DEMO_PRICE_CENTS
	const generatedOffer = createDynamicDemoOffer(userMessage, priceCents)
	const looksLikeShopping =
		/(buy|purchase|shop|find|looking for|recommend|need|want|upgrade|replace|for my|under\s*\$|around\s*\$|\$\s*\d+)/i.test(
			userMessage
		)
	await ensureSchema(c.env.DB)
	const buyerLinked =
		(await c.env.DB
			.prepare(`SELECT user_id FROM users WHERE user_id = ?1`)
			.bind(userId)
			.first<{ user_id: string }>()) !== null

	try {
		const result = await c.env.AI.run('@hf/nousresearch/hermes-2-pro-mistral-7b', {
			messages: [
				{
					role: 'system',
					content: [
						'You are a shopping agent in a hackathon demo.',
						'Always call the route_buyer_message tool exactly once.',
						'Classify the buyer message and generate the reply text.',
						'Use intent smalltalk for greetings or non-shopping chat.',
						'Use intent needs_buyer when the user wants to buy something but has no linked cash account yet.',
						'Use intent shopping_quote when the user wants to buy something and the linked cash account already exists.',
						'If the user mentions a product, hardware, food, a budget, or a shopping need in a casual way, treat it as shopping, not smalltalk.',
						'Messages like "RAM for my computer", "a muffin around $5", or "need a backpack under $80" are shopping requests.',
						'If intent is needs_buyer, suggest /link-cash.',
						'If intent is shopping_quote, suggest /approve-purchase.',
						'Keep the reply concise, natural, and conversational.',
						`The buyer linked account status is: ${buyerLinked ? 'linked' : 'not linked'}.`,
						`If you are quoting an item, the product label is: ${generatedOffer.productLabel}.`,
						`If you are quoting an item, the quoted price is: $${(generatedOffer.priceCents / 100).toFixed(2)}.`,
						`If you are quoting an item, the next action is /approve-purchase.`,
						`If the buyer is not linked yet, the next action is /link-cash.`,
					].join(' '),
				},
				{
					role: 'user',
					content: userMessage,
				},
			],
			tools: [
				{
					name: 'route_buyer_message',
					description: 'Route the buyer message for the demo UI',
					parameters: {
						type: 'object',
						properties: {
							intent: {
								type: 'string',
								enum: ['smalltalk', 'needs_buyer', 'shopping_quote'],
							},
							reply: {
								type: 'string',
								description: 'Short conversational reply for the buyer',
							},
							suggestedAction: {
								type: 'string',
								enum: ['', '/link-cash', '/approve-purchase'],
							},
							productLabel: {
								type: 'string',
								description: 'Short product label if the user is shopping',
							},
						},
						required: ['intent', 'reply', 'suggestedAction'],
					},
				},
			],
			tool_choice: 'auto',
			max_tokens: 220,
		})
		const resultObject = typeof result === 'object' && result !== null ? result : null
		const rawToolCalls =
			resultObject !== null &&
			'tool_calls' in resultObject &&
			Array.isArray(resultObject.tool_calls)
				? resultObject.tool_calls
				: resultObject !== null &&
					  'response' in resultObject &&
					  typeof resultObject.response === 'object' &&
					  resultObject.response !== null &&
					  'tool_calls' in resultObject.response &&
					  Array.isArray(resultObject.response.tool_calls)
					? resultObject.response.tool_calls
					: []

		const firstToolCall = rawToolCalls[0] as
			| { arguments?: unknown }
			| undefined

		let routed:
			| {
					intent: 'smalltalk' | 'needs_buyer' | 'shopping_quote'
					reply: string
					suggestedAction: '' | '/link-cash' | '/approve-purchase'
					productLabel?: string
			  }
			| undefined

		if (firstToolCall !== undefined && firstToolCall.arguments !== undefined) {
			const args =
				typeof firstToolCall.arguments === 'string'
					? JSON.parse(firstToolCall.arguments)
					: firstToolCall.arguments

			if (
				typeof args === 'object' &&
				args !== null &&
				'intent' in args &&
				'reply' in args &&
				'suggestedAction' in args &&
				(args.intent === 'smalltalk' ||
					args.intent === 'needs_buyer' ||
					args.intent === 'shopping_quote') &&
				typeof args.reply === 'string' &&
				(args.suggestedAction === '' ||
					args.suggestedAction === '/link-cash' ||
					args.suggestedAction === '/approve-purchase')
			) {
				routed = {
					intent: args.intent,
					reply: args.reply.trim(),
					suggestedAction: args.suggestedAction,
					productLabel:
						'productLabel' in args && typeof args.productLabel === 'string'
							? args.productLabel.trim()
							: undefined,
				}
			}
		}

		if (routed === undefined) {
			if (!looksLikeShopping) {
				routed = {
					intent: 'smalltalk',
					reply: 'Hi. I can help you shop for something and then walk the private payment flow once you are ready.',
					suggestedAction: '',
				}
			} else if (!buyerLinked) {
				routed = {
					intent: 'needs_buyer',
					reply: 'I can help with that purchase. First, link a buyer cash account so I can prepare the payment flow.',
					suggestedAction: '/link-cash',
				}
			} else {
				routed = {
					intent: 'shopping_quote',
					reply: 'I found a matching option and a checkout path. If you want me to proceed, confirm and I will handle the private payment flow.',
					suggestedAction: '/approve-purchase',
				}
			}
		}

		const productLabel =
			routed.productLabel !== undefined && routed.productLabel !== ''
				? routed.productLabel
				: generatedOffer.productLabel
		const effectiveIntent =
			routed.intent === 'smalltalk' && looksLikeShopping
				? buyerLinked
					? 'shopping_quote'
					: 'needs_buyer'
				:
			routed.intent === 'shopping_quote' && !buyerLinked ? 'needs_buyer' : routed.intent
		const suggestedAction =
			effectiveIntent === 'needs_buyer'
				? '/link-cash'
				: effectiveIntent === 'shopping_quote'
					? '/approve-purchase'
					: ''
		const checkoutLink = effectiveIntent === 'shopping_quote' ? generatedOffer.checkoutLink : ''
		let responseReply = routed.reply
		if (effectiveIntent !== routed.intent) {
			const rewriteResult = await c.env.AI.run('@hf/nousresearch/hermes-2-pro-mistral-7b', {
				messages: [
					{
						role: 'system',
						content: [
							'You are rewriting a shopping assistant reply for a hackathon demo.',
							'Write one short, natural, human-sounding sentence.',
							`The intended intent is ${effectiveIntent}.`,
							`The next step is ${suggestedAction || 'no explicit action'}.`,
							`The product label is ${productLabel}.`,
							`If quoting, the quoted price is $${(generatedOffer.priceCents / 100).toFixed(2)}.`,
							'If there is a next step, mention that exact slash command and do not mention any other slash command.',
						].join(' '),
					},
					{
						role: 'user',
						content: userMessage,
					},
				],
				max_tokens: 120,
			})
			const rewrittenReply =
				typeof rewriteResult === 'string'
					? rewriteResult.trim()
					: typeof rewriteResult === 'object' &&
						  rewriteResult !== null &&
						  'response' in rewriteResult &&
						  typeof rewriteResult.response === 'string'
						? rewriteResult.response.trim()
						: ''
			if (rewrittenReply !== '') {
				responseReply = rewrittenReply
			}
		}
		if (responseReply === '') {
			responseReply =
				effectiveIntent === 'smalltalk'
					? 'Hi. Tell me what you want to buy and I will help you through it.'
					: effectiveIntent === 'needs_buyer'
						? 'I can help with that purchase. Link your bank account first, then I can quote it.'
						: 'I found a matching option and can take you through the private payment flow when you are ready.'
		}
		const responseBody = {
			mode: 'cloudflare-ai-tools',
			reply: responseReply,
			intent: effectiveIntent,
			suggestedAction,
			buyerLinked,
			productLabel: effectiveIntent === 'smalltalk' ? null : productLabel,
			priceCents: effectiveIntent === 'shopping_quote' ? generatedOffer.priceCents : null,
			finalChargeCents: effectiveIntent === 'shopping_quote' ? generatedOffer.finalChargeCents : null,
			discountCents: effectiveIntent === 'shopping_quote' ? generatedOffer.discountCents : null,
			checkoutLink,
			requiresConfirmation: effectiveIntent === 'shopping_quote',
			targetPrivateBalanceCents:
				effectiveIntent === 'shopping_quote'
					? generatedOffer.priceCents
					: null,
		}

		return c.json(responseBody)
	} catch (error) {
		return c.json(
			{
				error: 'Cloudflare AI request failed',
				detail: error instanceof Error ? error.message : String(error),
			},
			502
		)
	}
})

app.post('/admin/demo-buyer', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}

	const payload = await parseJson<unknown>(c.req.raw)
	const userId =
		typeof payload === 'object' &&
		payload !== null &&
		'userId' in payload &&
		typeof payload.userId === 'string' &&
		payload.userId.trim() !== ''
			? payload.userId.trim()
			: 'jane-doe'

	await ensureReady(c, userId)
	const user = await loadUser(c.env.DB, userId)
	const liveDetails =
		currentColumnMode(c.env.COLUMN_MODE) === 'live'
			? await c.env.DB
					.prepare(`SELECT * FROM column_live_users WHERE user_id = ?1`)
					.bind(userId)
					.first<LiveColumnUserRow>()
			: null

	return c.json({
		buyer: {
			userId,
			startingCashCents: user.fiat_cents,
			startingCashUsd: (user.fiat_cents / 100).toFixed(2),
			linkedBankAccountId: user.column_account_id,
			privateWalletId: user.unlink_wallet_id,
		},
		linkedBanking:
			liveDetails === null
				? null
				: {
						entityId: liveDetails.entity_id,
						bankAccountId: liveDetails.bank_account_id,
						accountNumberId: liveDetails.account_number_id,
						seededAmountCents: liveDetails.seeded_amount_cents,
				  },
	})
})

app.get('/demo/terminal', async (c) => {
	const initialAdminToken = c.req.query('adminToken') ?? undefined
	const initialUserId = c.req.query('userId') ?? undefined
	const autoplay = c.req.query('autoplay') === '1'

	return c.html(renderTerminalDemoUi({
		initialAdminToken,
		initialUserId,
		autoplay,
	}))
})

app.post('/admin/reset', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	await resetState(c.env.DB)
	return c.json({ ok: true })
})

app.post('/admin/live-column-smoke', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	const apiKey = c.env.COLUMN_SANDBOX_API_KEY
	if (apiKey === undefined || apiKey.trim() === '') {
		return c.json({ error: 'COLUMN_SANDBOX_API_KEY is required' }, 400)
	}

	const body = await parseJson<{ fundingAmountCents?: number; transferAmountCents?: number }>(
		c.req.raw
	).catch((): { fundingAmountCents?: number; transferAmountCents?: number } => ({}))
	const fundingAmountCents =
		typeof body.fundingAmountCents === 'number' && body.fundingAmountCents > 0
			? body.fundingAmountCents
			: 5_000
	const transferAmountCents =
		typeof body.transferAmountCents === 'number' && body.transferAmountCents > 0
			? body.transferAmountCents
			: 2_000

	if (transferAmountCents > fundingAmountCents) {
		return c.json({ error: 'transferAmountCents must be <= fundingAmountCents' }, 400)
	}

	const result = await runLiveColumnSmoke(apiKey, fundingAmountCents, transferAmountCents)
	return c.json({ result })
})

app.post('/admin/unlink-smoke', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	const body = await parseJson<{ userId?: string }>(c.req.raw).catch(
		(): { userId?: string } => ({})
	)
	const userId = body.userId?.trim() || 'unlink-smoke-user'
	const unlinkMode = currentUnlinkMode(c.env.UNLINK_MODE)
	let unlinkClient: UnlinkClient
	let sdkAvailable = unlinkMode === 'container'
	let fallbackUsed = false
	let wallet

	if (unlinkMode === 'mock') {
		unlinkClient = createMockUnlinkClient()
		wallet = await unlinkClient.createManagedWallet(userId)
		sdkAvailable = false
	} else {
		try {
			unlinkClient = createUnlinkClient(c.env)
			wallet = await unlinkClient.createManagedWallet(userId)
		} catch (caughtError) {
			const error =
				caughtError instanceof Error
					? caughtError.message
					: 'Unknown Unlink wallet creation failure'
			return c.json(
				{
					error,
					result: {
						mode: unlinkMode,
						userId,
						walletId: '',
						address: '',
						sdkAvailable: false,
						fallbackUsed: false,
					} satisfies UnlinkSmokeResult,
				},
				502
			)
		}
	}

	const result: UnlinkSmokeResult = {
		mode: unlinkMode,
		userId: wallet.userId,
		walletId: wallet.walletId,
		address: wallet.address,
		sdkAvailable,
		fallbackUsed,
	}

	return c.json({ result })
})

app.get('/balances', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	const userId = c.req.query('userId') ?? 'demo-user'
	const createIfMissing = c.req.query('create') !== '0'
	await ensureSchema(c.env.DB)
	await ensureSystemState(c.env.DB)
	let user: UserRow | null = null
	if (createIfMissing) {
		await ensureReady(c, userId)
		user = await loadUser(c.env.DB, userId)
	} else {
		user = await c.env.DB
			.prepare('SELECT * FROM users WHERE user_id = ?1')
			.bind(userId)
			.first<UserRow>()
	}
	const system = await loadSystem(c.env.DB)

	return c.json({
		user:
			user === null
				? null
				: {
					userId: user.user_id,
					columnAccountId: user.column_account_id,
					unlinkWalletId: user.unlink_wallet_id,
					fiatCents: user.fiat_cents,
					privatePusdCents: user.private_pusd_cents,
				},
		system: {
			reserveCents: system.reserve_cents,
			opsCents: system.ops_cents,
			totalSupplyCents: system.total_supply_cents,
			treasuryPublicPusdCents: system.treasury_public_pusd_cents,
			payerPublicPusdCents: system.payer_public_pusd_cents,
			sharedPayerWallet: c.env.SHARED_PAYER_WALLET,
		},
	})
})

app.post('/mint-intents', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	const body = MintRequestSchema.parse(await parseJson<unknown>(c.req.raw))
	enforceMaxAmount(body.amountCents, currentMaxAmount(c.env.MAX_INTENT_AMOUNT_CENTS))
	await ensureReady(c, body.userId)
	const user = await loadUser(c.env.DB, body.userId)
	if (user.fiat_cents < body.amountCents) {
		return c.json({ error: 'Insufficient fiat balance' }, 400)
	}

	const mintIntentId = await createMintIntentRecord(c.env.DB, body.userId, body.amountCents)

	if (shouldUseAsyncIntentFlow(c.env) && !shouldWaitForIntent(c)) {
		const intent = await loadMintIntent(c.env.DB, mintIntentId)
		c.header('location', `/mint-intents/${mintIntentId}`)
		return c.json(
			{
				intent,
				async: true,
				pollPath: `/mint-intents/${mintIntentId}?wait=true`,
			},
			202
		)
	}

	const processed = await processMintIntentById(c.env, c.env.DB, mintIntentId)
	const system = processed.system
	const updatedUser = processed.user
	const intent = processed.intent

	return c.json({
		intent,
		columnMode: currentColumnMode(c.env.COLUMN_MODE),
		user: {
			fiatCents: updatedUser.fiat_cents,
			privatePusdCents: updatedUser.private_pusd_cents,
		},
		system: {
			reserveCents: system.reserve_cents,
			totalSupplyCents: system.total_supply_cents,
		},
	})
})

app.get('/mint-intents/:id', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	await ensureSchema(c.env.DB)
	const mintIntentId = c.req.param('id')
	let intent = await c.env.DB
		.prepare(`SELECT * FROM mint_intents WHERE id = ?1`)
		.bind(mintIntentId)
		.first<MintIntentRow>()

	if (intent === null) {
		return c.json({ error: 'Mint intent not found' }, 404)
	}

	if (
		shouldUseAsyncIntentFlow(c.env) &&
		shouldWaitForIntent(c) &&
		intent.status !== 'completed' &&
		intent.status !== 'failed' &&
		intent.status !== 'manual_review'
	) {
		try {
			intent = (await processMintIntentById(c.env, c.env.DB, mintIntentId)).intent
		} catch {
			intent = await loadMintIntent(c.env.DB, mintIntentId)
		}
	}

	return c.json({ intent })
})

app.post('/burn-intents', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	const body = BurnRequestSchema.parse(await parseJson<unknown>(c.req.raw))
	enforceMaxAmount(body.amountCents, currentMaxAmount(c.env.MAX_INTENT_AMOUNT_CENTS))
	await ensureReady(c, body.userId)
	const user = await loadUser(c.env.DB, body.userId)
	if (user.private_pusd_cents < body.amountCents) {
		return c.json({ error: 'Insufficient private PUSD balance' }, 400)
	}

	const burnIntentId = await createBurnIntentRecord(c.env.DB, body.userId, body.amountCents)

	if (shouldUseAsyncIntentFlow(c.env) && !shouldWaitForIntent(c)) {
		const intent = await loadBurnIntent(c.env.DB, burnIntentId)
		c.header('location', `/burn-intents/${burnIntentId}`)
		return c.json(
			{
				intent,
				async: true,
				pollPath: `/burn-intents/${burnIntentId}?wait=true`,
			},
			202
		)
	}

	try {
		const processed = await processBurnIntentById(c.env, c.env.DB, burnIntentId)
		return c.json({
			intent: processed.intent,
			user: processed.user,
			system: processed.system,
		})
	} catch (caughtError) {
		const latest = await loadBurnIntent(c.env.DB, burnIntentId)
		if (latest.status === 'manual_review') {
			return c.json({ error: latest.error ?? 'Reserve balance too low for payout' }, 409)
		}
		throw caughtError
	}
})

app.get('/burn-intents/:id', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	await ensureSchema(c.env.DB)
	const burnIntentId = c.req.param('id')
	let intent = await c.env.DB
		.prepare(`SELECT * FROM burn_intents WHERE id = ?1`)
		.bind(burnIntentId)
		.first<BurnIntentRow>()

	if (intent === null) {
		return c.json({ error: 'Burn intent not found' }, 404)
	}

	if (
		shouldUseAsyncIntentFlow(c.env) &&
		shouldWaitForIntent(c) &&
		intent.status !== 'completed' &&
		intent.status !== 'failed' &&
		intent.status !== 'manual_review'
	) {
		try {
			intent = (await processBurnIntentById(c.env, c.env.DB, burnIntentId)).intent
		} catch {
			intent = await loadBurnIntent(c.env.DB, burnIntentId)
		}
	}

	return c.json({ intent })
})

app.get('/demo/paid', async (c) => {
	await ensureSchema(c.env.DB)
	await ensureSystemState(c.env.DB)
	const paymentSignatureHeader = c.req.header('PAYMENT-SIGNATURE')
	const challengeIdHeader = c.req.header('x-pusd-challenge-id')
	const receiptIdHeader = c.req.header('x-pusd-payment-receipt')
	let challengeId = challengeIdHeader
	let receiptId = receiptIdHeader

	if (paymentSignatureHeader !== undefined) {
		let paymentSignature: PaymentSignaturePayload
		try {
			paymentSignature = decodeBase64Json<PaymentSignaturePayload>(paymentSignatureHeader)
		} catch {
			return c.json({ error: 'Invalid PAYMENT-SIGNATURE header' }, 400)
		}
		challengeId = paymentSignature.challengeId
		receiptId = paymentSignature.receiptId
	}

	if (challengeId === undefined || receiptId === undefined) {
		const generatedChallengeId = createIntentId('challenge')
		const requestedAmount = Number.parseInt(c.req.query('amountCents') ?? '', 10)
		const amountCents =
			Number.isFinite(requestedAmount) && requestedAmount > 0
				? requestedAmount
				: Number.parseInt(c.env.DEMO_PRICE_CENTS, 10) || DEFAULT_DEMO_PRICE_CENTS
		enforceMaxAmount(amountCents, currentMaxAmount(c.env.MAX_INTENT_AMOUNT_CENTS))

		await c.env.DB
			.prepare(
				`INSERT INTO x402_challenges (
					id,
					amount_cents,
					status,
					receipt_id
				) VALUES (?1, ?2, 'pending', NULL)`
			)
			.bind(generatedChallengeId, amountCents)
			.run()

		const challenge: ChallengePayload = {
			challengeId: generatedChallengeId,
			amountCents,
			token: {
				name: TOKEN_NAME,
				symbol: TOKEN_SYMBOL,
				standard: TOKEN_STANDARD,
				chainId: MONAD_TESTNET_CHAIN_ID,
				caip2: MONAD_CAIP2,
			},
			facilitatorPath: '/facilitator/settle',
			payerWallet: c.env.SHARED_PAYER_WALLET,
			settlementMode: 'demo-ledger',
		}

		c.header('PAYMENT-REQUIRED', encodeBase64Json(challenge))
		c.header('x-pusd-settlement-mode', 'demo-ledger')
		return c.json(
			{
				error: 'payment_required',
				challenge,
			},
			402
		)
	}

	const challenge = await c.env.DB
		.prepare(`SELECT * FROM x402_challenges WHERE id = ?1`)
		.bind(challengeId)
		.first<ChallengeRow>()

	if (challenge === null || challenge.status !== 'settled' || challenge.receipt_id !== receiptId) {
		return c.json({ error: 'Invalid or unsettled payment receipt' }, 402)
	}

	await c.env.DB
		.prepare(`UPDATE x402_challenges SET status = 'consumed' WHERE id = ?1`)
		.bind(challengeId)
		.run()

	const paymentResponse: PaymentResponsePayload = {
		challengeId,
		receiptId,
		transaction: null,
		settlementMode: 'demo-ledger',
	}
	c.header('x-pusd-settlement-mode', 'demo-ledger')
	c.header('PAYMENT-RESPONSE', encodeBase64Json(paymentResponse))

	return c.json({
		ok: true,
		message: 'Paid x402 demo resource delivered',
		receiptId,
	})
})

app.post('/x402/ensure-funds', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	const body = EnsureFundsRequestSchema.parse(await parseJson<unknown>(c.req.raw))
	enforceMaxAmount(body.amountCents, currentMaxAmount(c.env.MAX_INTENT_AMOUNT_CENTS))
	await ensureReady(c, body.userId)
	let system = await loadSystem(c.env.DB)
	let user = await loadUser(c.env.DB, body.userId)
	const unlinkClient = createUnlinkClient(c.env)
	const fundingIntentId = createIntentId('fund')

	await c.env.DB
		.prepare(
			`INSERT INTO x402_funding_intents (
				id,
				user_id,
				amount_cents,
				status,
				source_mint_intent_id,
				challenge_id,
				error
			) VALUES (?1, ?2, ?3, 'initiated', NULL, NULL, NULL)`
		)
		.bind(fundingIntentId, body.userId, body.amountCents)
		.run()

	let sourceMintIntentId: string | null = null
	let needed = Math.max(0, body.amountCents - system.payer_public_pusd_cents)

	if (needed > 0 && user.private_pusd_cents < needed) {
		const topUpAmount = needed - user.private_pusd_cents
		const reserveAccountId = await currentReserveAccountId(c.env, c.env.DB)
		const minted = await createEmbeddedMint(
			c.env,
			c.env.DB,
			user,
			system,
			topUpAmount,
			reserveAccountId
		)
		user = minted.user
		system = minted.system
		sourceMintIntentId = minted.mintIntentId
	}

	needed = Math.max(0, body.amountCents - system.payer_public_pusd_cents)

	if (needed > 0) {
		if (user.private_pusd_cents < needed) {
			await c.env.DB
				.prepare(`UPDATE x402_funding_intents SET status = 'failed', error = ?2 WHERE id = ?1`)
				.bind(fundingIntentId, 'Unable to source enough private PUSD for payer funding')
				.run()
			return c.json({ error: 'Unable to source enough private PUSD for payer funding' }, 400)
		}

		const exit = await unlinkClient.exitToPublic({
			walletId: user.unlink_wallet_id,
			amountCents: needed,
			destination: c.env.SHARED_PAYER_WALLET,
		})

		user = {
			...user,
			private_pusd_cents: user.private_pusd_cents - needed,
		}

		system = mapLedgerToSystem(
			system,
			exitPrivateToPayer(
				{
					totalSupplyCents: system.total_supply_cents,
					treasuryPublicPusdCents: system.treasury_public_pusd_cents,
					payerPublicPusdCents: system.payer_public_pusd_cents,
				},
				needed
			)
		)

		await saveUser(c.env.DB, user)
		await saveSystem(c.env.DB, system)
		await c.env.DB
			.prepare(
				`UPDATE x402_funding_intents
				 SET status = 'completed',
				     source_mint_intent_id = ?2
				 WHERE id = ?1`
			)
			.bind(fundingIntentId, sourceMintIntentId)
			.run()
	} else {
		await c.env.DB
			.prepare(
				`UPDATE x402_funding_intents
				 SET status = 'completed',
				     source_mint_intent_id = ?2
				 WHERE id = ?1`
			)
			.bind(fundingIntentId, sourceMintIntentId)
			.run()
	}

	const intent = await c.env.DB
		.prepare(`SELECT * FROM x402_funding_intents WHERE id = ?1`)
		.bind(fundingIntentId)
		.first<FundingIntentRow>()

	return c.json({
		intent,
		user,
		system,
	})
})

app.get('/x402/funding-intents/:id', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	await ensureSchema(c.env.DB)
	const intent = await c.env.DB
		.prepare(`SELECT * FROM x402_funding_intents WHERE id = ?1`)
		.bind(c.req.param('id'))
		.first<FundingIntentRow>()

	if (intent === null) {
		return c.json({ error: 'Funding intent not found' }, 404)
	}

	return c.json({ intent })
})

app.post('/facilitator/settle', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	const body = FacilitatorSettlementSchema.parse(await parseJson<unknown>(c.req.raw))
	await ensureSchema(c.env.DB)
	const challenge = await c.env.DB
		.prepare(`SELECT * FROM x402_challenges WHERE id = ?1`)
		.bind(body.challengeId)
		.first<ChallengeRow>()

	if (challenge === null || challenge.status !== 'pending') {
		return c.json({ error: 'Unknown or invalid challenge' }, 404)
	}

	let system = await loadSystem(c.env.DB)
	system = mapLedgerToSystem(
		system,
		settleX402Payment(
			{
				totalSupplyCents: system.total_supply_cents,
				treasuryPublicPusdCents: system.treasury_public_pusd_cents,
				payerPublicPusdCents: system.payer_public_pusd_cents,
			},
			challenge.amount_cents
		)
	)

	await saveSystem(c.env.DB, system)

	const receiptId = createIntentId('receipt')
	await c.env.DB
		.prepare(`UPDATE x402_challenges SET status = 'settled', receipt_id = ?2 WHERE id = ?1`)
		.bind(body.challengeId, receiptId)
		.run()

	c.header('x-pusd-settlement-mode', 'demo-ledger')
	return c.json({
		ok: true,
		receiptId,
		challengeId: body.challengeId,
		payerWallet: c.env.SHARED_PAYER_WALLET,
		settlementMode: 'demo-ledger',
		settlementTransaction: null,
	})
})

app.post('/admin/reconcile', async (c) => {
	const authError = requireProtectedRouteAuth(c)
	if (authError !== null) {
		return authError
	}
	await ensureSchema(c.env.DB)
	await ensureSystemState(c.env.DB)
	const system = await loadSystem(c.env.DB)
	const healthy = system.reserve_cents >= system.total_supply_cents

	return c.json({
		healthy,
		reserveCents: system.reserve_cents,
		totalSupplyCents: system.total_supply_cents,
	})
})

export { UnlinkContainer }
export default app
