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

app.get('/demo/public', async (c) => {
	return c.json({
		name: 'PUSD Hackathon Demo Worker',
		chainId: MONAD_TESTNET_CHAIN_ID,
		token: {
			name: TOKEN_NAME,
			symbol: TOKEN_SYMBOL,
			standard: TOKEN_STANDARD,
		},
	})
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
	await ensureReady(c, userId)
	const system = await loadSystem(c.env.DB)
	const user = await loadUser(c.env.DB, userId)

	return c.json({
		user: {
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
	await ensureReady(c, 'demo-user')
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
		const amountCents = Number.parseInt(c.env.DEMO_PRICE_CENTS, 10) || DEFAULT_DEMO_PRICE_CENTS

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
	await ensureReady(c, 'demo-user')
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
