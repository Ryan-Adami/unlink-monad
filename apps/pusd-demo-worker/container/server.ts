import { createServer } from 'node:http'

const { createSdkBackedUnlinkClient } = await import(
	new URL('../../../packages/unlink-client/src/sdk.ts', import.meta.url).href
)

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000
const AUTH_TOKEN = process.env.UNLINK_INTERNAL_AUTH_TOKEN?.trim() || ''
const STATE_DIR = process.env.UNLINK_STATE_DIR?.trim() || '/tmp/unlink-state'
const CHAIN = 'monad-testnet'

function writeJson(
	response: import('node:http').ServerResponse,
	statusCode: number,
	body: unknown
): void {
	response.statusCode = statusCode
	response.setHeader('content-type', 'application/json')
	response.end(JSON.stringify(body))
}

async function readJson(request: import('node:http').IncomingMessage): Promise<unknown> {
	const chunks: Uint8Array[] = []
	for await (const chunk of request) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
	}

	if (chunks.length === 0) {
		return {}
	}

	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function isAuthorized(request: import('node:http').IncomingMessage): boolean {
	if (AUTH_TOKEN === '') {
		return false
	}
	return request.headers['x-unlink-internal-auth'] === AUTH_TOKEN
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value
}

async function createRuntimeClient(request: import('node:http').IncomingMessage) {
	const tokenAddress =
		firstHeaderValue(request.headers['x-unlink-token-address'])?.trim() ||
		process.env.PUSD_TOKEN_ADDRESS?.trim() ||
		''
	const depositorPrivateKey =
		process.env.UNLINK_DEPOSITOR_PRIVATE_KEY?.trim() || ''
	const chainRpcUrl =
		firstHeaderValue(request.headers['x-unlink-chain-rpc-url'])?.trim() ||
		process.env.MONAD_RPC_URL?.trim() ||
		'https://testnet-rpc.monad.xyz'
	const tokenDecimalsValue =
		firstHeaderValue(request.headers['x-unlink-token-decimals'])?.trim() ||
		process.env.PUSD_TOKEN_DECIMALS?.trim() ||
		'18'
	const tokenDecimals = Number.parseInt(tokenDecimalsValue, 10)

	return createSdkBackedUnlinkClient({
		chain: CHAIN,
		stateDir: STATE_DIR,
		chainRpcUrl,
		tokenAddress,
		tokenDecimals: Number.isFinite(tokenDecimals) ? tokenDecimals : 18,
		depositorPrivateKey,
	})
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
	if (request.method === 'GET' && url.pathname === '/health') {
		writeJson(response, 200, {
			ok: true,
			chain: CHAIN,
			stateDir: STATE_DIR,
		})
		return
	}

	if (AUTH_TOKEN === '') {
		writeJson(response, 503, { error: 'UNLINK_INTERNAL_AUTH_TOKEN is required' })
		return
	}

	if (!isAuthorized(request)) {
		writeJson(response, 401, { error: 'unauthorized' })
		return
	}

	try {
		const unlinkClient = await createRuntimeClient(request)
		const body = await readJson(request)

		if (request.method === 'POST' && url.pathname === '/wallets') {
			const userId =
				typeof (body as { userId?: unknown }).userId === 'string'
					? (body as { userId: string }).userId.trim()
					: ''
			if (userId === '') {
				writeJson(response, 400, { error: 'userId is required' })
				return
			}

			const wallet = await unlinkClient.createManagedWallet(userId)
			writeJson(response, 200, { result: wallet })
			return
		}

		if (request.method === 'POST' && url.pathname === '/deposit') {
			const payload = body as { walletId?: string; amountCents?: number }
			if (
				typeof payload.walletId !== 'string' ||
				payload.walletId.trim() === '' ||
				typeof payload.amountCents !== 'number' ||
				payload.amountCents <= 0
			) {
				writeJson(response, 400, { error: 'walletId and amountCents are required' })
				return
			}

			const result = await unlinkClient.depositToPrivate({
				walletId: payload.walletId,
				amountCents: payload.amountCents,
			})
			writeJson(response, 200, { result })
			return
		}

		if (request.method === 'POST' && url.pathname === '/exit') {
			const payload = body as {
				walletId?: string
				amountCents?: number
				destination?: string
			}
			if (
				typeof payload.walletId !== 'string' ||
				payload.walletId.trim() === '' ||
				typeof payload.amountCents !== 'number' ||
				payload.amountCents <= 0 ||
				typeof payload.destination !== 'string' ||
				payload.destination.trim() === ''
			) {
				writeJson(response, 400, {
					error: 'walletId, amountCents, and destination are required',
				})
				return
			}

			const result = await unlinkClient.exitToPublic({
				walletId: payload.walletId,
				amountCents: payload.amountCents,
				destination: payload.destination,
			})
			writeJson(response, 200, { result })
			return
		}

		writeJson(response, 404, { error: 'not_found' })
	} catch (error) {
		writeJson(response, 500, {
			error: error instanceof Error ? error.message : 'unknown_error',
		})
	}
})

server.listen(PORT, () => {
	process.stdout.write(`unlink-container listening on ${PORT}\n`)
})
