import {
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
	parseUnits,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

export interface ChainLedgerState {
	totalSupplyCents: number
	treasuryPublicPusdCents: number
	payerPublicPusdCents: number
}

export interface DemoChainAccount {
	address: string
	privateKey: `0x${string}`
}

export interface MonadClientBundle {
	account: ReturnType<typeof privateKeyToAccount>
	publicClient: ReturnType<typeof createPublicClient>
	walletClient: ReturnType<typeof createWalletClient>
	rpcUrl: string
}

interface LivePusdConfig {
	privateKey: `0x${string}`
	contractAddress: `0x${string}`
	rpcUrl?: string
	tokenDecimals?: number
}

const pusdAbi = [
	{
		type: 'function',
		name: 'mint',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'to', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'burn',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'from', type: 'address' },
			{ name: 'amount', type: 'uint256' },
		],
		outputs: [],
	},
] as const

export const MONAD_TESTNET_RPC_URL = 'https://testnet-rpc.monad.xyz'

export const monadTestnetChain = defineChain({
	id: 10143,
	name: 'Monad Testnet',
	network: 'monad-testnet',
	nativeCurrency: {
		name: 'Monad',
		symbol: 'MON',
		decimals: 18,
	},
	rpcUrls: {
		default: {
			http: [MONAD_TESTNET_RPC_URL],
		},
	},
	blockExplorers: {
		default: {
			name: 'Monad Explorer',
			url: 'https://testnet.monadexplorer.com',
		},
	},
	testnet: true,
})

export function createDemoChainAccount(): DemoChainAccount {
	const privateKey = generatePrivateKey()
	const account = privateKeyToAccount(privateKey)

	return {
		address: account.address,
		privateKey,
	}
}

export function createMonadClientBundle(
	privateKey: `0x${string}`,
	rpcUrl = MONAD_TESTNET_RPC_URL
): MonadClientBundle {
	const account = privateKeyToAccount(privateKey)
	const transport = http(rpcUrl)

	return {
		account,
		publicClient: createPublicClient({
			chain: monadTestnetChain,
			transport,
		}),
		walletClient: createWalletClient({
			account,
			chain: monadTestnetChain,
			transport,
		}),
		rpcUrl,
	}
}

function centsToTokenUnits(amountCents: number, tokenDecimals: number): bigint {
	return parseUnits((amountCents / 100).toFixed(2), tokenDecimals)
}

export function getMonadAccountAddress(privateKey: `0x${string}`): `0x${string}` {
	return privateKeyToAccount(privateKey).address
}

export async function mintPusdOnchain(
	config: LivePusdConfig & { recipient?: `0x${string}`; amountCents: number }
): Promise<`0x${string}`> {
	const tokenDecimals = config.tokenDecimals ?? 18
	const client = createMonadClientBundle(config.privateKey, config.rpcUrl ?? MONAD_TESTNET_RPC_URL)
	const recipient = config.recipient ?? client.account.address
	const hash = await client.walletClient.writeContract({
		address: config.contractAddress,
		abi: pusdAbi,
		functionName: 'mint',
		args: [recipient, centsToTokenUnits(config.amountCents, tokenDecimals)],
		account: client.account,
		chain: monadTestnetChain,
	})

	await client.publicClient.waitForTransactionReceipt({
		hash,
	})

	return hash
}

export async function burnPusdOnchain(
	config: LivePusdConfig & { amountCents: number }
): Promise<`0x${string}`> {
	const tokenDecimals = config.tokenDecimals ?? 18
	const client = createMonadClientBundle(config.privateKey, config.rpcUrl ?? MONAD_TESTNET_RPC_URL)
	const hash = await client.walletClient.writeContract({
		address: config.contractAddress,
		abi: pusdAbi,
		functionName: 'burn',
		args: [client.account.address, centsToTokenUnits(config.amountCents, tokenDecimals)],
		account: client.account,
		chain: monadTestnetChain,
	})

	await client.publicClient.waitForTransactionReceipt({
		hash,
	})

	return hash
}

export function mintToTreasury(state: ChainLedgerState, amountCents: number): ChainLedgerState {
	return {
		...state,
		totalSupplyCents: state.totalSupplyCents + amountCents,
		treasuryPublicPusdCents: state.treasuryPublicPusdCents + amountCents,
	}
}

export function depositMintedToPrivate(
	state: ChainLedgerState,
	amountCents: number
): ChainLedgerState {
	if (state.treasuryPublicPusdCents < amountCents) {
		throw new Error('Insufficient treasury public balance for private deposit')
	}

	return {
		...state,
		treasuryPublicPusdCents: state.treasuryPublicPusdCents - amountCents,
	}
}

export function exitPrivateToPayer(state: ChainLedgerState, amountCents: number): ChainLedgerState {
	return {
		...state,
		payerPublicPusdCents: state.payerPublicPusdCents + amountCents,
	}
}

export function exitPrivateToTreasury(
	state: ChainLedgerState,
	amountCents: number
): ChainLedgerState {
	return {
		...state,
		treasuryPublicPusdCents: state.treasuryPublicPusdCents + amountCents,
	}
}

export function burnFromTreasury(state: ChainLedgerState, amountCents: number): ChainLedgerState {
	if (state.treasuryPublicPusdCents < amountCents || state.totalSupplyCents < amountCents) {
		throw new Error('Insufficient treasury public balance to burn')
	}

	return {
		...state,
		totalSupplyCents: state.totalSupplyCents - amountCents,
		treasuryPublicPusdCents: state.treasuryPublicPusdCents - amountCents,
	}
}

export function settleX402Payment(state: ChainLedgerState, amountCents: number): ChainLedgerState {
	if (state.payerPublicPusdCents < amountCents) {
		throw new Error('Shared payer wallet lacks sufficient public PUSD')
	}

	return {
		...state,
		payerPublicPusdCents: state.payerPublicPusdCents - amountCents,
	}
}
