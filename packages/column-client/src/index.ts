export interface ColumnClientConfig {
	apiKey?: string
	mode?: 'mock' | 'live'
	platformName?: string
}

export interface ColumnBookTransferInput {
	sourceAccountId: string
	destinationAccountId: string
	amountCents: number
	description: string
}

export interface ColumnBookTransferResult extends ColumnBookTransferInput {
	transferId: string
	status: 'completed'
	settledAt: string
	mode: 'mock' | 'live'
}

export interface ColumnClient {
	mode: 'mock' | 'live'
	createBookTransfer(input: ColumnBookTransferInput): Promise<ColumnBookTransferResult>
	createBusinessEntity?(input: ColumnCreateBusinessEntityInput): Promise<ColumnEntity>
	createPersonEntity?(input: ColumnCreatePersonEntityInput): Promise<ColumnEntity>
	createBankAccount?(input: ColumnCreateBankAccountInput): Promise<ColumnBankAccount>
	getBankAccount?(bankAccountId: string): Promise<ColumnBankAccount>
	simulateReceiveWire?(input: ColumnSimulateReceiveWireInput): Promise<void>
}

export interface ColumnAddress {
	line_1: string
	line_2?: string
	city: string
	state?: string
	postal_code: string
	country_code: string
}

export interface ColumnEntity {
	id: string
	name: string
	type: string
	verification_status: string
}

export interface ColumnCreateBusinessEntityInput {
	businessName: string
	ein: string
	address: ColumnAddress
}

export interface ColumnCreatePersonEntityInput {
	firstName: string
	lastName: string
	ssn: string
	dateOfBirth: string
	email: string
	phoneNumber: string
	address: ColumnAddress
}

export interface ColumnCreateBankAccountInput {
	entityId: string
	description?: string
}

export interface ColumnBankAccount {
	id: string
	defaultAccountNumberId: string
	defaultAccountNumber: string
	routingNumber: string
	availableAmount: number
	ownerEntityIds: string[]
}

export interface ColumnSimulateReceiveWireInput {
	destinationAccountNumberId: string
	amountCents: number
}

function basicAuthHeader(apiKey: string): string {
	return `Basic ${Buffer.from(`:${apiKey}`).toString('base64')}`
}

async function requestColumn<T>(
	apiKey: string,
	path: string,
	init: RequestInit = {}
): Promise<T> {
	const response = await fetch(`https://api.column.com${path}`, {
		...init,
		headers: {
			Authorization: basicAuthHeader(apiKey),
			'Content-Type': 'application/json',
			...(init.headers ?? {}),
		},
	})

	if (!response.ok) {
		const body = await response.text()
		throw new Error(`Column API ${response.status} for ${path}: ${body}`)
	}

	if (response.status === 204) {
		return undefined as T
	}

	return (await response.json()) as T
}

function fromColumnBankAccount(response: {
	id: string
	default_account_number_id: string
	default_account_number: string
	routing_number: string
	balances?: { available_amount?: number }
	owners?: string[]
}): ColumnBankAccount {
	return {
		id: response.id,
		defaultAccountNumberId: response.default_account_number_id,
		defaultAccountNumber: response.default_account_number,
		routingNumber: response.routing_number,
		availableAmount: response.balances?.available_amount ?? 0,
		ownerEntityIds: response.owners ?? [],
	}
}

function createLiveColumnClient(apiKey: string): ColumnClient {
	return {
		mode: 'live',
		async createBusinessEntity(input) {
			const response = await requestColumn<{
				id: string
				name: string
				type: string
				verification_status: string
			}>(apiKey, '/entities/business', {
				method: 'POST',
				body: JSON.stringify({
					business_name: input.businessName,
					ein: input.ein,
					legal_type: 'llc',
					website: 'https://example.com',
					description: 'PUSD hackathon live demo entity',
					industry: 'Software',
					state_of_incorporation: input.address.state ?? 'CA',
					year_of_incorporation: '2024',
					countries_of_operation: ['US'],
					address: input.address,
					is_root: false,
				}),
			})

			return response
		},
		async createPersonEntity(input) {
			const response = await requestColumn<{
				id: string
				name: string
				type: string
				verification_status: string
			}>(apiKey, '/entities/person', {
				method: 'POST',
				body: JSON.stringify({
					first_name: input.firstName,
					last_name: input.lastName,
					ssn: input.ssn,
					date_of_birth: input.dateOfBirth,
					email: input.email,
					phone_number: input.phoneNumber,
					address: input.address,
					is_root: false,
				}),
			})

			return response
		},
		async createBankAccount(input) {
			const response = await requestColumn<{
				id: string
				default_account_number_id: string
				default_account_number: string
				routing_number: string
				balances?: { available_amount?: number }
				owners?: string[]
			}>(apiKey, '/bank-accounts', {
				method: 'POST',
				body: JSON.stringify({
					entity_id: input.entityId,
					description: input.description ?? '',
				}),
			})

			return fromColumnBankAccount(response)
		},
		async getBankAccount(bankAccountId) {
			const response = await requestColumn<{
				id: string
				default_account_number_id: string
				default_account_number: string
				routing_number: string
				balances?: { available_amount?: number }
				owners?: string[]
			}>(apiKey, `/bank-accounts/${bankAccountId}`)

			return fromColumnBankAccount(response)
		},
		async simulateReceiveWire(input) {
			await requestColumn<Record<string, never>>(apiKey, '/simulate/receive-wire', {
				method: 'POST',
				body: JSON.stringify({
					destination_account_number_id: input.destinationAccountNumberId,
					amount: input.amountCents.toString(),
					currency_code: 'USD',
				}),
			})
		},
		async createBookTransfer(input) {
			const response = await requestColumn<{
				id: string
				status: string
				updated_at?: string
				created_at?: string
			}>(apiKey, '/transfers/book', {
				method: 'POST',
				headers: {
					'Idempotency-Key': `book_${crypto.randomUUID()}`,
				},
				body: JSON.stringify({
					description: input.description,
					amount: input.amountCents,
					currency_code: 'USD',
					sender_bank_account_id: input.sourceAccountId,
					receiver_bank_account_id: input.destinationAccountId,
				}),
			})

			return {
				...input,
				transferId: response.id,
				status: 'completed',
				settledAt: response.updated_at ?? response.created_at ?? new Date().toISOString(),
				mode: 'live',
			}
		},
	}
}

export function createColumnClient(config: ColumnClientConfig = {}): ColumnClient {
	const mode = config.mode ?? 'mock'

	if (mode === 'live') {
		if (config.apiKey === undefined || config.apiKey.trim() === '') {
			throw new Error('COLUMN_SANDBOX_API_KEY is required for live Column mode')
		}

		return createLiveColumnClient(config.apiKey)
	}

	return {
		mode,
		async createBookTransfer(input) {
			return {
				...input,
				transferId: `col_${crypto.randomUUID()}`,
				status: 'completed',
				settledAt: new Date().toISOString(),
				mode,
			}
		},
	}
}
