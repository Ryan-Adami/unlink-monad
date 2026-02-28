import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'

interface NamedContainerStub {
	fetch(input: Request | string, init?: RequestInit): Promise<Response>
}

interface NamedContainerBinding {
	getByName(name: string): NamedContainerStub
}

interface WorkersAiBinding {
	run(
		model: string,
		input: Record<string, unknown>,
		options?: Record<string, unknown>
	): Promise<unknown>
}

export type Env = SharedHonoEnv & {
	DB: D1Database
	AI?: WorkersAiBinding
	DEMO_INITIAL_USER_FIAT_CENTS: string
	DEMO_PRICE_CENTS: string
	MAX_INTENT_AMOUNT_CENTS: string
	COLUMN_MODE: 'mock' | 'live'
	UNLINK_MODE: 'mock' | 'container'
	UNLINK_CONTAINER?: NamedContainerBinding
	UNLINK_CONTAINER_INSTANCE?: string
	UNLINK_SERVICE_BASE_URL?: string
	UNLINK_INTERNAL_AUTH_TOKEN?: string
	DEMO_ADMIN_TOKEN?: string
	UNLINK_DEPOSITOR_PRIVATE_KEY?: string
	RESERVE_ACCOUNT_ID: string
	OPS_ACCOUNT_ID: string
	TREASURY_WALLET_ADDRESS: string
	SHARED_PAYER_WALLET: string
	COLUMN_SANDBOX_API_KEY?: string
	MONAD_RPC_URL?: string
	PUSD_TOKEN_ADDRESS?: string
	PUSD_TOKEN_DECIMALS?: string
}

export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
