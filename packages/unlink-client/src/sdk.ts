import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
	createPublicClient,
	createWalletClient,
	defineChain,
	formatUnits,
	http,
	parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { ManagedWallet, UnlinkClient, UnlinkOperationResult } from './index'

export interface SdkUnlinkConfig {
	chain?: 'monad-testnet'
	stateDir?: string
	chainRpcUrl?: string
	tokenAddress?: string
	tokenDecimals?: number
	depositorPrivateKey?: string
}

const erc20Abi = [
	{
		type: 'function',
		name: 'approve',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'spender', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
		outputs: [{ name: '', type: 'bool' }],
	},
	{
		type: 'function',
		name: 'allowance',
		stateMutability: 'view',
		inputs: [
			{ name: 'owner', type: 'address' },
			{ name: 'spender', type: 'address' },
		],
		outputs: [{ name: '', type: 'uint256' }],
	},
] as const

const walletCache = new Map<string, Promise<any>>()

function createFallbackAddress(seed: string): string {
	return `0x${Array.from(seed)
		.map((character) => character.charCodeAt(0).toString(16))
		.join('')
		.slice(0, 40)
		.padEnd(40, '0')}`
}

function sanitizeUserId(userId: string): string {
	return userId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')
}

function walletIdToUserId(walletId: string): string {
	return walletId.startsWith('unlink_') ? walletId.slice('unlink_'.length) : walletId
}

function monadTestnetChain(rpcUrl: string) {
	return defineChain({
		id: 10143,
		name: 'Monad Testnet',
		nativeCurrency: {
			name: 'MON',
			symbol: 'MON',
			decimals: 18,
		},
		rpcUrls: {
			default: {
				http: [rpcUrl],
			},
		},
	})
}

function requireRuntimeConfig(config: Required<SdkUnlinkConfig>) {
	if (config.tokenAddress.trim() === '') {
		throw new Error('Unlink SDK runtime requires a tokenAddress')
	}
	if (config.depositorPrivateKey.trim() === '') {
		throw new Error('Unlink SDK runtime requires a depositorPrivateKey')
	}
	if (config.tokenDecimals < 2) {
		throw new Error('tokenDecimals must be at least 2 to represent cents')
	}
}

function centsToTokenUnits(amountCents: number, tokenDecimals: number): bigint {
	return parseUnits((amountCents / 100).toFixed(2), tokenDecimals)
}

function createOperationResult(
	operationId: string,
	details?: Record<string, string>
): UnlinkOperationResult {
	return {
		operationId:
			details === undefined
				? operationId
				: `${operationId}:${Object.entries(details)
						.map(([key, value]) => `${key}=${value}`)
						.join(',')}`,
		status: 'completed',
		recordedAt: new Date().toISOString(),
	}
}

async function loadWallet(userId: string, config: Required<SdkUnlinkConfig>): Promise<any> {
	const cacheKey = `${config.chain}:${userId}`
	const cached = walletCache.get(cacheKey)
	if (cached !== undefined) {
		return cached
	}

	const pending = (async (): Promise<any> => {
		const { createSqliteStorage, initUnlink } = await import('@unlink-xyz/node')
		await mkdir(config.stateDir, { recursive: true })
		const storagePath = join(config.stateDir, `${sanitizeUserId(userId)}.sqlite`)
		const unlink = await initUnlink({
			chain: config.chain,
			storage: createSqliteStorage({
				path: storagePath,
			}),
			autoSync: false,
			sync: false,
			setup: true,
			chainRpcUrl: config.chainRpcUrl,
		})

		const active = await unlink.accounts.getActive()
		if (active === null) {
			await unlink.accounts.create()
		}

		return unlink
	})()

	walletCache.set(cacheKey, pending)

	try {
		return await pending
	} catch (error) {
		walletCache.delete(cacheKey)
		throw error
	}
}

async function createManagedWallet(userId: string, config: Required<SdkUnlinkConfig>): Promise<ManagedWallet> {
	const unlink = await loadWallet(userId, config)
	const activeAccount = await unlink.accounts.getActive()
	const address =
		typeof activeAccount?.address === 'string'
			? activeAccount.address
			: createFallbackAddress(userId)

	return {
		userId,
		walletId: `unlink_${userId}`,
		address,
	}
}

async function ensureAllowance(
	tokenAddress: `0x${string}`,
	spender: `0x${string}`,
	amount: bigint,
	account: ReturnType<typeof privateKeyToAccount>,
	rpcUrl: string
): Promise<void> {
	const chain = monadTestnetChain(rpcUrl)
	const publicClient = createPublicClient({
		chain,
		transport: http(rpcUrl),
	})
	const walletClient = createWalletClient({
		account,
		chain,
		transport: http(rpcUrl),
	})

	const currentAllowance = await publicClient.readContract({
		address: tokenAddress,
		abi: erc20Abi,
		functionName: 'allowance',
		args: [account.address, spender],
	})

	if (currentAllowance >= amount) {
		return
	}

	const approveHash = await walletClient.writeContract({
		address: tokenAddress,
		abi: erc20Abi,
		functionName: 'approve',
		args: [spender, amount],
		account,
		chain,
	})

	await publicClient.waitForTransactionReceipt({
		hash: approveHash,
	})
}

async function submitDeposit(
	unlink: any,
	config: Required<SdkUnlinkConfig>,
	amountCents: number
): Promise<UnlinkOperationResult> {
	requireRuntimeConfig(config)
	const tokenAddress = config.tokenAddress as `0x${string}`
	const depositor = privateKeyToAccount(config.depositorPrivateKey as `0x${string}`)
	const amount = centsToTokenUnits(amountCents, config.tokenDecimals)
	const rpcUrl = config.chainRpcUrl
	const chain = monadTestnetChain(rpcUrl)
	const publicClient = createPublicClient({
		chain,
		transport: http(rpcUrl),
	})
	const walletClient = createWalletClient({
		account: depositor,
		chain,
		transport: http(rpcUrl),
	})

	await ensureAllowance(tokenAddress, unlink.poolAddress as `0x${string}`, amount, depositor, rpcUrl)

	const deposit = await unlink.deposit({
		depositor: depositor.address,
		deposits: [
			{
				token: tokenAddress,
				amount,
			},
		],
	})

	const txHash = await walletClient.sendTransaction({
		account: depositor,
		to: deposit.to as `0x${string}`,
		data: deposit.calldata as `0x${string}`,
		value: deposit.value,
		chain,
	})

	await publicClient.waitForTransactionReceipt({
		hash: txHash,
	})
	await unlink.confirmDeposit(deposit.relayId)
	await unlink.sync()

	return createOperationResult(deposit.relayId, {
		amount: formatUnits(amount, config.tokenDecimals),
		txHash,
	})
}

async function submitWithdrawal(
	unlink: any,
	config: Required<SdkUnlinkConfig>,
	amountCents: number,
	destination: string
): Promise<UnlinkOperationResult> {
	requireRuntimeConfig(config)
	const { waitForConfirmation } = await import('@unlink-xyz/node')
	const tokenAddress = config.tokenAddress as `0x${string}`
	const amount = centsToTokenUnits(amountCents, config.tokenDecimals)
	await unlink.sync()

	const withdrawal = await unlink.withdraw({
		withdrawals: [
			{
				token: tokenAddress,
				amount,
				recipient: destination,
			},
		],
	})

	const status = await waitForConfirmation(unlink, withdrawal.relayId, {
		timeout: 180_000,
		pollInterval: 2_000,
	})
	await unlink.sync()

	return createOperationResult(withdrawal.relayId, {
		amount: formatUnits(amount, config.tokenDecimals),
		txHash: status.txHash ?? 'unknown',
	})
}

export async function createSdkBackedUnlinkClient(
	config: SdkUnlinkConfig = {}
): Promise<UnlinkClient> {
	const resolvedConfig: Required<SdkUnlinkConfig> = {
		chain: config.chain ?? 'monad-testnet',
		stateDir: config.stateDir ?? '/tmp/unlink-state',
		chainRpcUrl: config.chainRpcUrl ?? 'https://testnet-rpc.monad.xyz',
		tokenAddress: config.tokenAddress ?? '',
		tokenDecimals: config.tokenDecimals ?? 18,
		depositorPrivateKey: config.depositorPrivateKey ?? '',
	}

	return {
		async createManagedWallet(userId) {
			return createManagedWallet(userId, resolvedConfig)
		},
		async depositToPrivate(input) {
			const unlink = await loadWallet(walletIdToUserId(input.walletId), resolvedConfig)
			return submitDeposit(unlink, resolvedConfig, input.amountCents)
		},
		async exitToPublic(input) {
			const unlink = await loadWallet(walletIdToUserId(input.walletId), resolvedConfig)
			return submitWithdrawal(unlink, resolvedConfig, input.amountCents, input.destination)
		},
	}
}
