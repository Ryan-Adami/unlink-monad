import solc from 'solc'
import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export interface CompiledPusdContract {
	abi: unknown[]
	bytecode: string
}

export interface DeployPusdContractInput {
	adminPrivateKey: `0x${string}`
	operatorAddress: `0x${string}`
	adminAddress?: `0x${string}`
	rpcUrl?: string
	compiled?: CompiledPusdContract
}

export interface DeployPusdContractResult {
	address: `0x${string}`
	deployTxHash: `0x${string}`
	chainId: number
	rpcUrl: string
	adminAddress: `0x${string}`
	operatorAddress: `0x${string}`
}

const MONAD_TESTNET_RPC_URL = 'https://testnet-rpc.monad.xyz'
const monadTestnetChain = defineChain({
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

export function compilePusdContract(source: string): CompiledPusdContract {
	const input = {
		language: 'Solidity',
		sources: {
			'PUSD.sol': {
				content: source,
			},
		},
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
			outputSelection: {
				'*': {
					'*': ['abi', 'evm.bytecode.object'],
				},
			},
		},
	}

	const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
		errors?: Array<{ severity: string; formattedMessage: string }>
		contracts?: {
			'PUSD.sol'?: {
				PUSD?: {
					abi: unknown[]
					evm: {
						bytecode: {
							object: string
						}
					}
				}
			}
		}
	}

	const errors = output.errors?.filter((entry) => entry.severity === 'error') ?? []
	if (errors.length > 0) {
		throw new Error(errors.map((entry) => entry.formattedMessage).join('\n\n'))
	}

	const contract = output.contracts?.['PUSD.sol']?.PUSD
	if (contract === undefined) {
		throw new Error('Failed to compile PUSD contract')
	}

	return {
		abi: contract.abi,
		bytecode: contract.evm.bytecode.object,
	}
}

export async function deployPusdContract(
	input: DeployPusdContractInput
): Promise<DeployPusdContractResult> {
	const rpcUrl = input.rpcUrl ?? MONAD_TESTNET_RPC_URL
	const deployer = privateKeyToAccount(input.adminPrivateKey)
	const adminAddress = input.adminAddress ?? deployer.address
	const compiled = input.compiled

	if (compiled === undefined) {
		throw new Error('A compiled PUSD contract artifact is required for deployment')
	}

	const transport = http(rpcUrl)
	const publicClient = createPublicClient({
		chain: monadTestnetChain,
		transport,
	})
	const walletClient = createWalletClient({
		account: deployer,
		chain: monadTestnetChain,
		transport,
	})
	const bytecode = compiled.bytecode.startsWith('0x')
		? (compiled.bytecode as `0x${string}`)
		: (`0x${compiled.bytecode}` as `0x${string}`)
	const deployTxHash = await walletClient.deployContract({
		abi: compiled.abi as Parameters<typeof walletClient.deployContract>[0]['abi'],
		account: deployer,
		bytecode,
		args: [adminAddress, input.operatorAddress],
	})
	const receipt = await publicClient.waitForTransactionReceipt({
		hash: deployTxHash,
	})

	if (receipt.contractAddress === null || receipt.contractAddress === undefined) {
		throw new Error('PUSD deployment completed without a contract address')
	}

	return {
		address: receipt.contractAddress,
		deployTxHash,
		chainId: monadTestnetChain.id,
		rpcUrl,
		adminAddress,
		operatorAddress: input.operatorAddress,
	}
}
