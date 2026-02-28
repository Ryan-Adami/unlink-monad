export interface ManagedWallet {
	userId: string
	walletId: string
	address: string
}

export interface UnlinkOperationResult {
	operationId: string
	status: 'completed'
	recordedAt: string
}

export interface UnlinkClient {
	createManagedWallet(userId: string): Promise<ManagedWallet>
	depositToPrivate(input: { walletId: string; amountCents: number }): Promise<UnlinkOperationResult>
	exitToPublic(input: {
		walletId: string
		amountCents: number
		destination: string
	}): Promise<UnlinkOperationResult>
}

export interface RemoteUnlinkClientOptions {
	authToken?: string
	baseUrl?: string
	fetcher?: typeof fetch
	request?: (path: string, init: RequestInit) => Promise<Response>
	additionalHeaders?: Record<string, string | undefined>
}

interface JsonResultEnvelope<T> {
	result: T
}

function createDemoAddress(seed: string): string {
	const normalized = Array.from(seed)
		.map((character) => character.charCodeAt(0).toString(16))
		.join('')
		.slice(0, 40)
	return `0x${normalized.padEnd(40, '0')}`
}

function createOperationResult(): UnlinkOperationResult {
	return {
		operationId: `unlink_${crypto.randomUUID()}`,
		status: 'completed',
		recordedAt: new Date().toISOString(),
	}
}

async function requestJson<T>(
	options: RemoteUnlinkClientOptions,
	path: string,
	body: unknown
): Promise<T> {
	const headers = new Headers({
		'content-type': 'application/json',
	})
	if (options.authToken !== undefined && options.authToken.trim() !== '') {
		headers.set('x-unlink-internal-auth', options.authToken)
	}
	for (const [key, value] of Object.entries(options.additionalHeaders ?? {})) {
		if (value !== undefined && value.trim() !== '') {
			headers.set(key, value)
		}
	}

	let response: Response
	if (options.request !== undefined) {
		response = await options.request(path, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	} else {
		if (options.baseUrl === undefined || options.baseUrl.trim() === '') {
			throw new Error('Remote Unlink client requires either baseUrl or request')
		}
		const fetcher = options.fetcher ?? fetch
		const url = new URL(path, options.baseUrl).toString()
		response = await fetcher(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	}

	if (!response.ok) {
		const errorBody = await response.text()
		throw new Error(`Unlink service request failed (${response.status}): ${errorBody}`)
	}

	return (await response.json()) as T
}

export function createRemoteUnlinkClient(options: RemoteUnlinkClientOptions): UnlinkClient {
	return {
		async createManagedWallet(userId) {
			const payload = await requestJson<JsonResultEnvelope<ManagedWallet>>(options, '/wallets', {
				userId,
			})
			return payload.result
		},
		async depositToPrivate(input) {
			const payload = await requestJson<JsonResultEnvelope<UnlinkOperationResult>>(
				options,
				'/deposit',
				input
			)
			return payload.result
		},
		async exitToPublic(input) {
			const payload = await requestJson<JsonResultEnvelope<UnlinkOperationResult>>(
				options,
				'/exit',
				input
			)
			return payload.result
		},
	}
}

export function createMockUnlinkClient(): UnlinkClient {
	return {
		async createManagedWallet(userId) {
			return {
				userId,
				walletId: `unlink_${userId}`,
				address: createDemoAddress(`unlink${userId}`),
			}
		},
		async depositToPrivate() {
			return createOperationResult()
		},
		async exitToPublic() {
			return createOperationResult()
		},
	}
}
